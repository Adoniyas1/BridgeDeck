//! The Browser tab: ordinary websites shown inside BridgeDeck's window. Each browser tab is a
//! native webview placed over the tab's page area (the page tells it where, and hides it when the
//! tab isn't on screen). Web pages have no access to BridgeDeck's commands: capabilities cover
//! BridgeDeck's own pages only, and Tauri refuses remote pages anything not granted to them.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::json;
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, Emitter, Manager, Url, WebviewBuilder, WebviewUrl,
};

const MAIN: &str = "main";

/// What browser pages say they are. macOS: Safari's own name (its engine is the same WebKit).
/// Windows: WebView2 already names itself as Edge, so it keeps its own.
#[cfg(target_os = "macos")]
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";

fn label(tab: &str) -> Result<String, String> {
    let ok = !tab.is_empty() && tab.len() <= 40 && tab.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(format!("browser-{tab}")) } else { Err("Invalid browser tab".into()) }
}

/// What was typed in the address bar, as a web address: a URL, a bare domain, or a search.
pub fn address(input: &str) -> Url {
    let text = input.trim();
    if let Ok(url) = Url::parse(text) {
        if matches!(url.scheme(), "http" | "https") {
            return url;
        }
    }
    let looks_like_host = !text.contains(char::is_whitespace) && text.contains('.') && !text.starts_with('.') && !text.ends_with('.');
    if looks_like_host {
        if let Ok(url) = Url::parse(&format!("https://{text}")) {
            return url;
        }
    }
    let mut search = Url::parse("https://duckduckgo.com/").expect("valid");
    search.query_pairs_mut().append_pair("q", text);
    search
}

/// Where each download in progress is being saved, by its address (macOS doesn't say when it ends).
static DOWNLOADS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

/// A file name that is safe to save: no folders, no characters Windows refuses.
fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() { "download".into() } else { cleaned.chars().take(160).collect() }
}

/// `folder/name`, or `folder/name (2).ext` and so on when that file already exists.
fn unique_path(folder: &Path, name: &str) -> PathBuf {
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (name.to_string(), String::new()),
    };
    (2..1000).map(|n| folder.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

/// The file name a download suggests: from the web view, else the address's last part.
fn download_name(url: &Url, suggested: &Path) -> String {
    let from_view = suggested.file_name().and_then(|n| n.to_str()).filter(|n| !n.is_empty());
    let from_url = url.path_segments().and_then(|mut s| s.next_back()).filter(|n| !n.is_empty()).and_then(crate::models::percent_decode);
    safe_name(&from_view.map(str::to_string).or(from_url).unwrap_or_else(|| "download".into()))
}

/// Downloads from web pages go to the Downloads folder; BridgeDeck says when each one is done.
fn on_download(app: &AppHandle, tab: &str, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let Ok(folder) = app.path().download_dir() else { return true };
            let path = unique_path(&folder, &download_name(&url, destination));
            *destination = path.clone();
            if let Ok(mut map) = DOWNLOADS.lock() {
                map.get_or_insert_with(HashMap::new).insert(url.to_string(), path.clone());
            }
            let _ = app.emit_to(MAIN, "browser-download", json!({ "tab": tab, "url": url.as_str(), "path": path, "state": "started" }));
        }
        DownloadEvent::Finished { url, path, success } => {
            let saved = DOWNLOADS.lock().ok().and_then(|mut map| map.as_mut().and_then(|m| m.remove(url.as_str())));
            let path = path.filter(|p| !p.as_os_str().is_empty()).or(saved);
            let state = if success { "done" } else { "failed" };
            let _ = app.emit_to(MAIN, "browser-download", json!({ "tab": tab, "url": url.as_str(), "path": path, "state": state }));
        }
        _ => {}
    }
    true
}

/// Only web pages are opened in the Browser tab.
fn allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about")
}

/// Shows the browser tab's page at `x, y` (`w × h`, logical pixels in the window), creating it on
/// first use; with `url`, goes there.
#[tauri::command]
pub fn browser_show(app: AppHandle, tab: String, url: Option<String>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let id = label(&tab)?;
    let (pos, size) = crate::placement::bounds(x, y, w, h);
    let target = url.as_deref().map(address);
    if let Some(view) = app.get_webview(&id) {
        view.set_position(pos).map_err(|e| e.to_string())?;
        view.set_size(size).map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
        if let Some(target) = target {
            view.navigate(target).map_err(|e| e.to_string())?;
        }
        crate::placement::verify(&app, &id, x, y);
        return Ok(());
    }
    let window = app.get_window(MAIN).ok_or("BridgeDeck's window isn't open")?;
    let start = target.unwrap_or_else(|| Url::parse("https://duckduckgo.com/").expect("valid"));
    let (nav_app, new_app, title_app, load_app, down_app) = (app.clone(), app.clone(), app.clone(), app.clone(), app.clone());
    let (nav_tab, nav_label, new_tab, title_tab, load_tab, down_tab) = (tab.clone(), id.clone(), id.clone(), tab.clone(), tab.clone(), tab.clone());
    let builder = WebviewBuilder::new(&id, WebviewUrl::External(start))
        // Files dropped here go to the page (e.g. attaching a file in ChatGPT), not to BridgeDeck's
        // own drop handler, which queues files for sending to the other computer.
        .disable_drag_drop_handler()
        .initialization_script(crate::webkeys::SCRIPT)
        .on_navigation(move |url| {
            let page = || nav_app.get_webview(&nav_label).and_then(|v| v.url().ok());
            if crate::webkeys::handle(&nav_app, &nav_tab, page, url) {
                return false;
            }
            let ok = allowed(url);
            if !ok {
                // Mail and other links open in the system's own app.
                if matches!(url.scheme(), "mailto" | "tel") {
                    let _ = tauri_plugin_opener::OpenerExt::opener(&nav_app).open_url(url.as_str(), None::<&str>);
                }
            }
            ok
        })
        // Links that open a new window open in this tab instead.
        .on_new_window(move |url, _| {
            if allowed(&url) {
                if let Some(view) = new_app.get_webview(&new_tab) {
                    let _ = view.navigate(url);
                }
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_, title| {
            let _ = title_app.emit_to(MAIN, "browser-title", json!({ "tab": title_tab, "title": title }));
        })
        .on_download(move |_, event| on_download(&down_app, &down_tab, event))
        .on_page_load(move |view, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            let _ = load_app.emit_to(MAIN, "browser-page", json!({ "tab": load_tab, "url": payload.url().as_str(), "loading": loading, "label": view.label() }));
        });
    // Present as Safari: macOS's built-in web view is Safari's engine but leaves "Safari" out of its
    // name, and many sites (streaming services above all) then show a blank page or "unsupported".
    #[cfg(target_os = "macos")]
    let builder = builder.user_agent(USER_AGENT);
    // Windows: Chrome extensions (extensions.rs) load into these pages, which keep their own browser
    // data folder (WebView2 shares a folder only between views made with the same settings).
    #[cfg(windows)]
    let builder = {
        let mut builder = builder.browser_extensions_enabled(true);
        if let Some(dir) = crate::extensions::dir(&app) {
            let _ = std::fs::create_dir_all(&dir);
            builder = builder.extensions_path(dir);
        }
        match crate::extensions::web_data_dir(&app) { Some(data) => builder.data_directory(data), None => builder }
    };
    window.add_child(builder, pos, size).map_err(|e| format!("Couldn't open the page: {e}"))?;
    crate::placement::verify(&app, &id, x, y);
    crate::adblock::attach(&app, &id);
    crate::webmedia::setup(&app, &id);
    Ok(())
}

/// Hides a browser tab's page (its tab is off screen); it keeps its place in history.
#[tauri::command]
pub fn browser_hide(app: AppHandle, tab: String) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label(&tab)?) {
        view.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Pauses the videos and sounds in a browser or TV page (the TV tab when it's left).
#[tauri::command]
pub fn browser_pause(app: AppHandle, tab: String) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label(&tab)?) {
        view.eval(crate::webmedia::PAUSE_MEDIA).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Back, forward, reload or stop in a browser tab.
#[tauri::command]
pub fn browser_go(app: AppHandle, tab: String, action: String) -> Result<(), String> {
    let view = app.get_webview(&label(&tab)?).ok_or("That page isn't open")?;
    match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        "stop" => view.eval("window.stop()"),
        _ => return Err("Unknown action".into()),
    }
    .map_err(|e| e.to_string())
}

/// Closes a browser tab's page.
#[tauri::command]
pub fn browser_close(app: AppHandle, tab: String) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label(&tab)?) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_bar_takes_urls_domains_and_searches() {
        assert_eq!(address("https://en.wikipedia.org/wiki/Chain_rule").as_str(), "https://en.wikipedia.org/wiki/Chain_rule");
        assert_eq!(address("  wikipedia.org ").as_str(), "https://wikipedia.org/");
        assert_eq!(address("chain rule calculus").as_str(), "https://duckduckgo.com/?q=chain+rule+calculus");
        assert_eq!(address("file:///etc/passwd").host_str(), Some("duckduckgo.com"), "only web pages");
        assert_eq!(address("javascript:alert(1)").host_str(), Some("duckduckgo.com"));
        assert!(label("1").is_ok() && label("../x").is_err() && label("").is_err());
        assert!(allowed(&Url::parse("https://x.org").unwrap()) && !allowed(&Url::parse("file:///x").unwrap()));
    }

    #[test]
    fn downloads_get_safe_unique_names() {
        let url = Url::parse("https://x.org/files/Lecture%201.pdf?x=1").unwrap();
        assert_eq!(download_name(&url, Path::new("")), "Lecture 1.pdf");
        assert_eq!(download_name(&url, Path::new("/tmp/notes.zip")), "notes.zip");
        assert_eq!(safe_name("../a:b?.txt"), "_a_b_.txt");
        assert_eq!(safe_name("..."), "download");
        let dir = std::env::temp_dir().join(format!("bd-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_path(&dir, "a.pdf"), dir.join("a.pdf"));
        std::fs::write(dir.join("a.pdf"), b"").unwrap();
        assert_eq!(unique_path(&dir, "a.pdf"), dir.join("a (2).pdf"));
        std::fs::write(dir.join("README"), b"").unwrap();
        assert_eq!(unique_path(&dir, "README"), dir.join("README (2)"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
