//! ChatGPT in a panel at the side of BridgeDeck's window (like a browser's assistant side panel):
//! chatgpt.com, signed in once and used by the person
//! themselves as a study and project helper. "Ask ChatGPT" in Study and Projects puts the text in
//! the message box (and on the clipboard) for the person to read, change and send; BridgeDeck never
//! sends messages.
//!
//! Chats are kept in BridgeDeck when the person presses "Save to BridgeDeck" in the panel's header
//! (next to New chat and Close): the conversation becomes a note (in the course or project it was started
//! from, else "ChatGPT"), on both computers and in search, and saving again updates it. The page
//! hands the conversation over by opening `https://bridgedeck.invalid/chatgpt-save?…` addresses,
//! which BridgeDeck catches and cancels. The panel has no access to BridgeDeck's commands
//! (remote pages get no commands), and what can arrive this way is limited to saving
//! chat notes, capped in size and rate.
//!
//! For the homework-from-a-photo import, BridgeDeck can also attach a photo to the message box
//! (the person still sends it) and read the chat back without saving it (`chatgpt_read`).

use base64::Engine;
use std::{collections::HashMap, sync::Mutex, time::Instant};
use tauri::{webview::PageLoadEvent, AppHandle, Manager, Url, WebviewBuilder, WebviewUrl};

const LABEL: &str = "chatgpt";
const URL: &str = "https://chatgpt.com/";
const SAVE_HOST: &str = "bridgedeck.invalid";
const DEFAULT_FOLDER: &str = "ChatGPT";
const MAX_PARTS: usize = 200;
const MAX_CHAT_BYTES: usize = 3 * 1024 * 1024;
const MAX_SAVES_PER_MINUTE: usize = 20;

/// Text waiting for the page to finish loading.
static PENDING: Mutex<Option<String>> = Mutex::new(None);
/// Where the next new chat is saved: the course or project ChatGPT was last opened from.
static FOLDER: Mutex<Option<String>> = Mutex::new(None);
/// Conversations arriving in parts, by save id.
static PARTS: Mutex<Option<HashMap<String, Vec<Option<String>>>>> = Mutex::new(None);
static SAVES: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
/// A photo waiting for the page to finish loading (a `data:` URL).
static PENDING_IMAGE: Mutex<Option<(String, String)>> = Mutex::new(None);
/// The next chat that arrives is handed to BridgeDeck's page (`chatgpt-chat`) instead of saved.
static READ_NEXT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const MAX_IMAGE: u64 = 25 * 1024 * 1024;

/// Script that attaches a picture to ChatGPT's message box once the page is ready: through the
/// page's own file picker input, else as a dropped file.
fn attach_script(name: &str, data_url: &str) -> String {
    let (name, data) = (serde_json::to_string(name).unwrap_or_default(), serde_json::to_string(data_url).unwrap_or_default());
    format!(
        r#"(() => {{
  const name = {name}, data = {data};
  let tries = 0;
  const timer = setInterval(() => {{
    const box = document.querySelector('#prompt-textarea') || document.querySelector('main textarea, main [contenteditable="true"]');
    const input = [...document.querySelectorAll('input[type="file"]')].find(i => !i.accept || /image/.test(i.accept)) || document.querySelector('input[type="file"]');
    if ((!box || !input) && ++tries < 80) return;
    clearInterval(timer);
    // Decoded here rather than fetched: the page's content rules may not allow data: fetches.
    const [head, body] = data.split(',');
    const raw = atob(body), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const file = new File([bytes], name, {{ type: head.slice(5, head.indexOf(';')) }});
    const files = new DataTransfer();
    files.items.add(file);
    if (input) {{
      input.files = files.files;
      input.dispatchEvent(new Event('change', {{ bubbles: true }}));
    }} else if (box) {{
      for (const type of ['dragenter', 'dragover', 'drop']) box.dispatchEvent(new DragEvent(type, {{ bubbles: true, cancelable: true, dataTransfer: files }}));
    }}
  }}, 250);
}})();"#
    )
}

/// Script that puts `text` in ChatGPT's message box once it appears (it doesn't send it).
pub fn fill_script(text: &str) -> String {
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(() => {{
  const text = {text};
  let tries = 0;
  const timer = setInterval(() => {{
    const box = document.querySelector('#prompt-textarea') || document.querySelector('main textarea, main [contenteditable="true"]');
    if (!box && ++tries < 80) return;
    clearInterval(timer);
    if (!box) return;
    box.focus();
    if (box instanceof HTMLTextAreaElement) {{
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text);
      box.dispatchEvent(new Event('input', {{ bubbles: true }}));
    }} else {{
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
    }}
  }}, 250);
}})();"#
    )
}

/// Gives the page `window.__bridgedeckSave()`, which the panel's "Save to BridgeDeck" button runs
/// (`chatgpt_save`). It reads the open conversation only then. (Older versions drew their own
/// button over the page; one left from before is removed.)
pub const SAVE_SCRIPT: &str = r#"(() => {
  document.getElementById('bridgedeck-save')?.remove();
  window.__bridgedeckSave = () => {
    const nodes = [...document.querySelectorAll('[data-message-author-role]')];
    const messages = nodes.map(n => ({ role: n.getAttribute('data-message-author-role'), text: (n.innerText || '').trim() })).filter(m => m.text && (m.role === 'user' || m.role === 'assistant'));
    if (!messages.length) { location.href = 'https://bridgedeck.invalid/chatgpt-save?empty=1'; return; }
    const chat = JSON.stringify({ url: location.href, title: document.title.replace(/\s*[|·-]\s*ChatGPT\s*$/i, '').trim(), messages });
    const bytes = new TextEncoder().encode(chat);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const data = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const size = 24000, parts = Math.ceil(data.length / size), id = Math.random().toString(36).slice(2, 12);
    let part = 0;
    const next = () => {
      if (part >= parts) return;
      location.href = 'https://bridgedeck.invalid/chatgpt-save?id=' + id + '&part=' + part + '&of=' + parts + '&d=' + data.slice(part * size, (part + 1) * size);
      part++;
      setTimeout(next, 60);
    };
    next();
  };
})();"#;

/// What the panel's button runs: the page's save, or (while the page hasn't loaded) "no chat".
const RUN_SAVE: &str = "(window.__bridgedeckSave || (() => { location.href = 'https://bridgedeck.invalid/chatgpt-save?empty=1'; }))()";

/// Tells the panel's header how a save went.
fn report(app: &AppHandle, ok: bool, message: &str) {
    use tauri::Emitter;
    let _ = app.emit_to("main", "chatgpt-saved", serde_json::json!({ "ok": ok, "message": message }));
}

#[derive(serde::Deserialize, Debug, PartialEq)]
pub struct Chat {
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(serde::Deserialize, Debug, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub text: String,
}

/// A part of a conversation from a save address; the whole chat once every part is in.
pub fn receive_part(url: &Url) -> Option<Result<Chat, String>> {
    if url.host_str() != Some(SAVE_HOST) || url.path() != "/chatgpt-save" {
        return None;
    }
    let query: HashMap<String, String> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let (Some(id), Some(part), Some(of), Some(data)) = (query.get("id"), query.get("part").and_then(|p| p.parse::<usize>().ok()), query.get("of").and_then(|p| p.parse::<usize>().ok()), query.get("d")) else {
        return Some(Err("A damaged save".into()));
    };
    if id.len() > 20 || of == 0 || of > MAX_PARTS || part >= of {
        return Some(Err("That chat is too long to save".into()));
    }
    let mut guard = PARTS.lock().ok()?;
    let all = guard.get_or_insert_with(HashMap::new);
    if !all.contains_key(id) && all.len() >= 8 {
        all.clear();
    }
    let parts = all.entry(id.clone()).or_insert_with(|| vec![None; of]);
    if parts.len() != of {
        all.remove(id);
        return Some(Err("A damaged save".into()));
    }
    parts[part] = Some(data.clone());
    if parts.iter().any(Option::is_none) {
        return None;
    }
    let joined: String = all.remove(id).unwrap_or_default().into_iter().flatten().collect();
    if joined.len() > MAX_CHAT_BYTES * 4 / 3 + 4 {
        return Some(Err("That chat is too long to save".into()));
    }
    let raw = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(joined.as_bytes()) {
        Ok(raw) => raw,
        Err(_) => return Some(Err("A damaged save".into())),
    };
    Some(serde_json::from_slice::<Chat>(&raw).map_err(|_| "A damaged save".to_string()))
}

/// The chat as note Markdown: a heading per turn.
pub fn chat_markdown(chat: &Chat) -> String {
    chat.messages
        .iter()
        .map(|m| format!("## {}\n\n{}", if m.role == "user" { "You" } else { "ChatGPT" }, m.text.trim()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn save(app: &AppHandle, chat: Chat) -> Result<(), String> {
    let source = Url::parse(&chat.url).map_err(|_| "A damaged save".to_string())?;
    if !source.host_str().is_some_and(|h| h == "chatgpt.com" || h.ends_with(".chatgpt.com")) {
        return Err("Only ChatGPT chats are saved".into());
    }
    {
        let mut saves = SAVES.lock().map_err(|e| e.to_string())?;
        saves.retain(|t| t.elapsed().as_secs() < 60);
        if saves.len() >= MAX_SAVES_PER_MINUTE {
            return Err("Saved too often; try again in a minute".into());
        }
        saves.push(Instant::now());
    }
    let title = if chat.title.trim().is_empty() { "ChatGPT chat".to_string() } else { format!("{} (ChatGPT)", chat.title.trim()) };
    let folder = FOLDER.lock().ok().and_then(|f| f.clone()).unwrap_or_else(|| DEFAULT_FOLDER.into());
    let manager = app.state::<crate::bridgelink::BridgeLinkManager>();
    crate::bridgelink::notes::save_chat(manager.inner(), source.as_str(), &title, &folder, &chat_markdown(&chat)).map(|_| ())
}

/// ChatGPT's own pages and the sign-in pages it uses stay in the panel.
fn keeps_in_panel(url: &Url) -> bool {
    const HOSTS: [&str; 6] = ["chatgpt.com", "openai.com", "accounts.google.com", "appleid.apple.com", "login.microsoftonline.com", "login.live.com"];
    url.scheme() == "https" && url.host_str().is_some_and(|h| HOSTS.iter().any(|d| h == *d || h.ends_with(&format!(".{d}"))))
}

fn fill(view: &tauri::Webview, text: &str) {
    let _ = view.eval(fill_script(text));
}

/// Shows ChatGPT as the panel at the side of BridgeDeck's window, at `x, y` (`w × h`, logical
/// pixels in the window), creating it on first use. With `text`, puts it in the message box.
/// `folder` is where chats started from here are saved (a course's or project's Notes folder).
/// Async, so the panel is made off the main thread (see `browser::browser_show`).
#[tauri::command]
pub async fn chatgpt_show(app: AppHandle, text: Option<String>, folder: Option<String>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || show(app, text, folder, x, y, w, h)).await.map_err(|e| e.to_string())?
}

fn show(app: AppHandle, text: Option<String>, folder: Option<String>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if folder.is_some() {
        if let Ok(mut stored) = FOLDER.lock() {
            *stored = folder.map(|f| f.trim().to_string()).filter(|f| !f.is_empty() && f.len() <= 80);
        }
    }
    if let Some(text) = &text {
        // Also on the clipboard, in case ChatGPT's page has changed and the box can't be found.
        if let Ok(mut board) = arboard::Clipboard::new() {
            let _ = board.set_text(text.clone());
        }
    }
    let (pos, size) = crate::placement::bounds(x, y, w, h);
    crate::browser::note_shown(LABEL, true);
    if let Some(view) = app.get_webview(LABEL) {
        view.set_position(pos).map_err(|e| e.to_string())?;
        view.set_size(size).map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
        if let Some(text) = &text {
            let _ = view.set_focus();
            fill(&view, text);
        }
        crate::placement::verify(&app, LABEL, x, y);
        return Ok(());
    }
    if let Ok(mut pending) = PENDING.lock() {
        *pending = text;
    }
    let window = app.get_window("main").ok_or("BridgeDeck's window isn't open")?;
    let handle = app.clone();
    let new_handle = app.clone();
    // After sleeping (browser.rs), the panel opens on the chat it had.
    let start = crate::browser::take_slept(LABEL).filter(keeps_in_panel).map(Ok).unwrap_or_else(|| URL.parse().map_err(|e| format!("{e}")))?;
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(start))
        // Files dropped here go to the page (e.g. attaching a file in ChatGPT), not to BridgeDeck's
        // own drop handler, which queues files for sending to the other computer.
        .disable_drag_drop_handler()
        .initialization_script(crate::webkeys::SCRIPT)
        .on_navigation(move |url| {
            let page = || handle.get_webview(LABEL).and_then(|v| v.url().ok());
            if crate::webkeys::handle(&handle, LABEL, page, url) {
                return false;
            }
            if url.host_str() == Some(SAVE_HOST) && url.query_pairs().any(|(k, _)| k == "empty") {
                if READ_NEXT.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    use tauri::Emitter;
                    let _ = handle.emit_to("main", "chatgpt-chat", serde_json::json!({ "ok": false, "message": "No chat in ChatGPT yet" }));
                    return false;
                }
                report(&handle, false, "No chat to save yet");
                return false;
            }
            let Some(result) = receive_part(url) else { return url.host_str() != Some(SAVE_HOST) };
            if READ_NEXT.swap(false, std::sync::atomic::Ordering::SeqCst) {
                use tauri::Emitter;
                let _ = match result {
                    Ok(chat) => handle.emit_to("main", "chatgpt-chat", serde_json::json!({ "ok": true, "messages": chat.messages.iter().map(|m| serde_json::json!({ "role": m.role, "text": m.text })).collect::<Vec<_>>() })),
                    Err(error) => handle.emit_to("main", "chatgpt-chat", serde_json::json!({ "ok": false, "message": error })),
                };
                return false;
            }
            match result.and_then(|chat| save(&handle, chat)) {
                Ok(()) => report(&handle, true, "Saved"),
                Err(error) => report(&handle, false, &error),
            }
            false
        })
        // Links ChatGPT opens as a new window (a chat, a task, signing in) open in the panel;
        // links to other sites open in the person's own browser.
        .on_new_window(move |url, _| {
            if keeps_in_panel(&url) {
                if let Some(view) = new_handle.get_webview(LABEL) {
                    let _ = view.navigate(url);
                }
            } else if matches!(url.scheme(), "http" | "https") {
                let _ = tauri_plugin_opener::OpenerExt::opener(&new_handle).open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(|view, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) && payload.url().host_str().is_some_and(|h| h.ends_with("chatgpt.com")) {
                let _ = view.eval(SAVE_SCRIPT);
                if let Some(text) = PENDING.lock().ok().and_then(|mut p| p.take()) {
                    fill(&view, &text);
                }
                if let Some((name, data)) = PENDING_IMAGE.lock().ok().and_then(|mut p| p.take()) {
                    let _ = view.eval(attach_script(&name, &data));
                }
            }
        });
    window.add_child(builder, pos, size).map_err(|e| format!("Couldn't open ChatGPT: {e}"))?;
    crate::placement::verify(&app, LABEL, x, y);
    crate::adblock::attach(&app, LABEL);
    crate::browser::hide_if_hidden_meanwhile(&app, LABEL);
    Ok(())
}

/// Hides the ChatGPT panel; the chat stays as it was for next time.
#[tauri::command]
pub fn chatgpt_hide(app: AppHandle) -> Result<(), String> {
    crate::browser::note_shown(LABEL, false);
    if let Some(view) = app.get_webview(LABEL) {
        view.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Saves the open chat as a note (the panel's "Save to BridgeDeck"); the result arrives as a
/// `chatgpt-saved` event.
#[tauri::command]
pub fn chatgpt_save(app: AppHandle) -> Result<(), String> {
    let view = app.get_webview(LABEL).ok_or("ChatGPT isn't open")?;
    view.eval(RUN_SAVE).map_err(|e| e.to_string())
}

/// Attaches a picture (a file on this computer) to the message box in the panel, for the person to
/// send. Call after the panel is shown.
#[tauri::command]
pub fn chatgpt_attach_image(app: AppHandle, path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "heic" => "image/heic",
        _ => return Err("Choose a photo (JPEG, PNG, HEIC or WebP)".into()),
    };
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_IMAGE {
        return Err("That photo is too big (25 MB at most)".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| format!("photo.{ext}"));
    let data = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
    match app.get_webview(LABEL) {
        Some(view) if view.url().is_ok_and(|u| u.host_str().is_some_and(|h| h.ends_with("chatgpt.com"))) => view.eval(attach_script(&name, &data)).map_err(|e| e.to_string()),
        _ => {
            if let Ok(mut pending) = PENDING_IMAGE.lock() {
                *pending = Some((name, data));
            }
            Ok(())
        }
    }
}

/// Reads the open chat back (for the homework import) without saving it; it arrives as a
/// `chatgpt-chat` event.
#[tauri::command]
pub fn chatgpt_read(app: AppHandle) -> Result<(), String> {
    let view = app.get_webview(LABEL).ok_or("ChatGPT isn't open")?;
    READ_NEXT.store(true, std::sync::atomic::Ordering::SeqCst);
    view.eval(RUN_SAVE).map_err(|e| e.to_string())
}

/// Starts a new chat in the panel.
#[tauri::command]
pub fn chatgpt_new(app: AppHandle) -> Result<(), String> {
    if let Some(view) = app.get_webview(LABEL) {
        view.navigate(URL.parse().map_err(|e| format!("{e}"))?).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chatgpt_and_sign_in_links_stay_in_the_panel() {
        let keep = |u: &str| keeps_in_panel(&Url::parse(u).unwrap());
        assert!(keep("https://chatgpt.com/c/123") && keep("https://auth.openai.com/log-in") && keep("https://accounts.google.com/o/oauth2"));
        assert!(!keep("https://example.com/") && !keep("http://chatgpt.com/") && !keep("https://chatgpt.com.evil.net/"));
    }

    #[test]
    fn the_text_goes_into_the_script_as_a_string_and_is_never_sent() {
        let script = fill_script("Explain \"this\"\n</script><img onerror=alert(1)> `${x}`");
        assert!(script.contains(r#"const text = "Explain \"this\"\n</script><img onerror=alert(1)> `${x}`";"#));
        assert!(!script.contains("submit") && !script.contains("click()") && !script.contains("Enter"));
    }

    fn parts(chat: &str, size: usize) -> Vec<Url> {
        let data = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(chat.as_bytes());
        let chunks: Vec<&str> = data.as_bytes().chunks(size).map(|c| std::str::from_utf8(c).unwrap()).collect();
        chunks.iter().enumerate().map(|(i, c)| Url::parse(&format!("https://bridgedeck.invalid/chatgpt-save?id=t1&part={i}&of={}&d={c}", chunks.len())).unwrap()).collect()
    }

    #[test]
    fn a_chat_arrives_in_parts_and_becomes_markdown() {
        let chat = r#"{"url":"https://chatgpt.com/c/abc","title":"Chain rule","messages":[{"role":"user","text":"What is the chain rule? ünïcode"},{"role":"assistant","text":"d/dx f(g(x)) = f'(g(x)) g'(x)\n\nExample: sin(x²)."}]}"#;
        let urls = parts(chat, 40);
        assert!(urls.len() > 3);
        // Parts can arrive out of order; nothing is saved until all are in.
        for url in urls.iter().rev().skip(1) {
            assert!(receive_part(url).is_none());
        }
        let done = receive_part(&urls[urls.len() - 1]).unwrap().unwrap();
        assert_eq!(done.title, "Chain rule");
        assert_eq!(chat_markdown(&done), "## You\n\nWhat is the chain rule? ünïcode\n\n## ChatGPT\n\nd/dx f(g(x)) = f'(g(x)) g'(x)\n\nExample: sin(x²).");
        // Other addresses are left alone; broken saves are refused.
        assert!(receive_part(&Url::parse("https://chatgpt.com/c/abc").unwrap()).is_none());
        assert!(receive_part(&Url::parse("https://bridgedeck.invalid/chatgpt-save?id=x&part=0&of=1&d=%%%").unwrap()).unwrap().is_err());
        assert!(receive_part(&Url::parse("https://bridgedeck.invalid/chatgpt-save?id=y&part=0&of=900&d=a").unwrap()).unwrap().is_err());
    }
}
