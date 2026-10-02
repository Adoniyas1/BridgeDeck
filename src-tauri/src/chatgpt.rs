//! ChatGPT in its own BridgeDeck window: chatgpt.com, signed in once and used by the person
//! themselves as a study and project helper. "Ask ChatGPT" in Study and Projects puts the text in
//! the message box (and on the clipboard) for the person to read, change and send; BridgeDeck never
//! sends messages or reads answers. The window is a plain web page: it has no access to BridgeDeck's
//! commands (capabilities cover the main window only).

use std::sync::Mutex;
use tauri::{webview::PageLoadEvent, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "chatgpt";
const URL: &str = "https://chatgpt.com/";

/// Text waiting for the page to finish loading.
static PENDING: Mutex<Option<String>> = Mutex::new(None);

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

fn fill(window: &tauri::WebviewWindow, text: &str) {
    let _ = window.eval(fill_script(text));
}

/// Opens (or brings forward) the ChatGPT window; with `text`, puts it in the message box.
#[tauri::command]
pub fn chatgpt_open(app: AppHandle, text: Option<String>) -> Result<(), String> {
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if let Some(text) = &text {
        // Also on the clipboard, in case ChatGPT's page has changed and the box can't be found.
        if let Ok(mut board) = arboard::Clipboard::new() {
            let _ = board.set_text(text.clone());
        }
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(text) = &text {
            fill(&window, text);
        }
        return Ok(());
    }
    if let Ok(mut pending) = PENDING.lock() {
        *pending = text;
    }
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(URL.parse().map_err(|e| format!("{e}"))?))
        .title("ChatGPT")
        .inner_size(1000.0, 820.0)
        .min_inner_size(420.0, 500.0)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) && payload.url().host_str().is_some_and(|h| h.ends_with("chatgpt.com")) {
                if let Some(text) = PENDING.lock().ok().and_then(|mut p| p.take()) {
                    fill(&window, &text);
                }
            }
        })
        .build()
        .map_err(|e| format!("Couldn't open ChatGPT: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_goes_into_the_script_as_a_string_and_is_never_sent() {
        let script = fill_script("Explain \"this\"\n</script><img onerror=alert(1)> `${x}`");
        assert!(script.contains(r#"const text = "Explain \"this\"\n</script><img onerror=alert(1)> `${x}`";"#));
        assert!(!script.contains("submit") && !script.contains("click()") && !script.contains("Enter"));
    }
}
