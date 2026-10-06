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

/// The blocker's script generation each page was made with (a page with an older one is remade
/// when next shown, so a change to the blocker reaches it).
static GENERATIONS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

fn made_with(label: &str) -> u64 {
    GENERATIONS.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(label).copied())).unwrap_or(0)
}

/// A window the pop-up guard (adblock/page.rs) marked as opened by the page's script: its real
/// address.
fn unwrap_popup(url: &Url) -> Option<Url> {
    if url.host_str() != Some("bridgedeck.invalid") || url.path() != "/popup" {
        return None;
    }
    url.query_pairs().find(|(k, _)| k == "u").and_then(|(_, v)| Url::parse(&v).ok()).filter(allowed)
}

static POPUP_WINDOWS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// A real pop-up window, still connected to the page that opened it (sign-in windows report back
/// to their page this way). It opens at the address the page asked for.
fn popup_window(app: &AppHandle, url: Url, features: tauri::webview::NewWindowFeatures) -> NewWindowResponse<tauri::Wry> {
    let n = POPUP_WINDOWS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let label = format!("browser-popup{n}");
    let nav_app = app.clone();
    let nav_label = label.clone();
    let builder = tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External(Url::parse("about:blank").expect("valid")))
        .window_features(features)
        .title(url.host_str().unwrap_or("BridgeDeck"))
        .min_inner_size(320.0, 240.0)
        .on_document_title_changed(|window, title| { let _ = window.set_title(&title); })
        // The guard's address is swapped for the real one (the window keeps its opener).
        .on_navigation(move |to| {
            if let Some(real) = unwrap_popup(to) {
                if let Some(view) = nav_app.get_webview(&nav_label) {
                    let _ = view.navigate(real);
                }
                return false;
            }
            allowed(to)
        })
        .on_new_window(|_, _| NewWindowResponse::Deny);
    #[cfg(target_os = "macos")]
    let builder = builder.user_agent(USER_AGENT);
    match builder.build() {
        Ok(window) => {
            crate::adblock::attach(app, &label);
            NewWindowResponse::Create { window }
        }
        Err(_) => NewWindowResponse::Deny,
    }
}

/// What happens to a new window a page asks for: blocked (and reported, so the person can open it
/// anyway), a real pop-up window (sized windows, such as sign-ins), or a new Browser tab.
fn new_window(app: &AppHandle, tab: &str, label: &str, url: Url, features: tauri::webview::NewWindowFeatures) -> NewWindowResponse<tauri::Wry> {
    let (real, scripted) = match unwrap_popup(&url) {
        Some(real) => (real, true),
        None => (url.clone(), false),
    };
    if !allowed(&real) {
        return NewWindowResponse::Deny;
    }
    let opener = app.get_webview(label).and_then(|v| v.url().ok());
    let opener_host = opener.as_ref().and_then(|u| u.host_str()).unwrap_or("").to_ascii_lowercase();
    if crate::adblock::popup(real.as_str(), &opener_host, scripted) == crate::adblock::Popup::Block {
        let _ = app.emit_to(MAIN, "browser-popup-blocked", json!({ "tab": tab, "url": real.as_str(), "opener": opener_host }));
        return NewWindowResponse::Deny;
    }
    let same_site = real.host_str().map(|h| crate::adblock::filters::site(&h.to_ascii_lowercase()) == crate::adblock::filters::site(&opener_host)).unwrap_or(false);
    if features.size().is_some() {
        // Pop-ups are opened at the guard's address, which the window swaps for the real one.
        return popup_window(app, real, features);
    }
    if tab == "tv" && same_site {
        if let Some(view) = app.get_webview(label) {
            let _ = view.navigate(real);
        }
        return NewWindowResponse::Deny;
    }
    let _ = app.emit_to(MAIN, "browser-open-tab", json!({ "tab": tab, "url": real.as_str() }));
    NewWindowResponse::Deny
}

/// Shows the browser tab's page at `x, y` (`w × h`, logical pixels in the window), creating it on
/// first use; with `url`, goes there.
#[tauri::command]
pub fn browser_show(app: AppHandle, tab: String, url: Option<String>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let id = label(&tab)?;
    let (pos, size) = crate::placement::bounds(x, y, w, h);
    let mut target = url.as_deref().map(address);
    // Made before the blocker last changed: remade (at the same page) with the new script.
    if let Some(view) = app.get_webview(&id).filter(|_| made_with(&id) < crate::adblock::generation()) {
        if target.is_none() {
            target = view.url().ok().filter(allowed);
        }
        let _ = view.close();
    }
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
    let new_tab_name = tab.clone();
    let generation = crate::adblock::generation();
    let mut builder = WebviewBuilder::new(&id, WebviewUrl::External(start))
        // Files dropped here go to the page (e.g. attaching a file in ChatGPT), not to BridgeDeck's
        // own drop handler, which queues files for sending to the other computer.
        .disable_drag_drop_handler()
        .initialization_script(crate::webkeys::SCRIPT);
    // The blocker's scripts: the pop-up guard and the page script (scriptlets; element hiding on
    // Windows, where WebKit's content blocker doesn't do it).
    if let Some(guard) = crate::adblock::popup_guard() {
        builder = builder.initialization_script_for_all_frames(guard);
    }
    let script = crate::adblock::page_script(cfg!(windows));
    if !script.is_empty() {
        builder = builder.initialization_script_for_all_frames(script);
    }
    let builder = builder
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
        .on_new_window(move |url, features| new_window(&new_app, &new_tab_name, &new_tab, url, features))
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
    if let Ok(mut g) = GENERATIONS.lock() {
        g.get_or_insert_with(HashMap::new).insert(id.clone(), generation);
    }
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
