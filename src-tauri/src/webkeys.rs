//! BridgeDeck's keyboard shortcuts inside web pages (the Browser and TV pages, the ChatGPT panel).
//! A web page has the keyboard while it's focused, so BridgeDeck's own window never hears the keys.
//! A small script in each page catches BridgeDeck's shortcuts and asks for them by opening
//! `https://bridgedeck.invalid/key?k=…` (with the selected text for "ask about this"), which
//! BridgeDeck catches and cancels like ChatGPT's save addresses. Only the listed shortcuts arrive,
//! and the page learns nothing back.

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Url};

const HOST: &str = "bridgedeck.invalid";
/// The shortcuts a page can ask for (the window's own list is in src/core/shortcuts.ts).
const KEYS: &[&str] = &["search", "chatgpt", "ask", "shortcuts", "new-tab", "close-tab", "address", "code"];
const MAX_TEXT: usize = 3000;

/// Runs in every page (main frame) before its own scripts.
pub const SCRIPT: &str = r#"(() => {
  if (window.__bridgedeckKeys) return;
  window.__bridgedeckKeys = true;
  const mac = /Mac/.test(navigator.platform);
  const plain = { k: 'search', j: 'chatgpt', '/': 'shortcuts', t: 'new-tab', w: 'close-tab', l: 'address' };
  const shifted = { a: 'ask', o: 'code' };
  addEventListener('keydown', e => {
    if (!(mac ? e.metaKey : e.ctrlKey) || e.altKey || (mac && e.ctrlKey)) return;
    const k = (e.shiftKey ? shifted : plain)[e.key.toLowerCase()];
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    const text = k === 'ask' ? String(getSelection() || '').trim().slice(0, 3000) : '';
    location.href = 'https://bridgedeck.invalid/key?k=' + k + (text ? '&t=' + encodeURIComponent(text) : '');
  }, true);
})();"#;

/// A shortcut a page asked for: its name and the selected text ("ask" only).
pub fn shortcut(url: &Url) -> Option<(String, String)> {
    if url.host_str() != Some(HOST) || url.path() != "/key" {
        return None;
    }
    let mut key = None;
    let mut text = String::new();
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "k" => key = KEYS.iter().find(|k| **k == value).map(|k| k.to_string()),
            "t" => text = value.chars().take(MAX_TEXT).collect(),
            _ => {}
        }
    }
    Some((key?, text))
}

/// Whether `url` is a shortcut address (always cancelled); a known shortcut is passed to the window.
/// `page` gives the page's own address (asked only for shortcut addresses).
pub fn handle(app: &AppHandle, source: &str, page: impl FnOnce() -> Option<Url>, url: &Url) -> bool {
    if url.host_str() != Some(HOST) || url.path() != "/key" {
        return false;
    }
    if let Some((key, text)) = shortcut(url) {
        let page = page().filter(|p| matches!(p.scheme(), "http" | "https")).map(|p| p.to_string());
        // Shortcuts that type into BridgeDeck (search, the address bar) give its window the keyboard.
        if matches!(key.as_str(), "search" | "shortcuts" | "address" | "new-tab") {
            if let Some(main) = app.get_webview("main") {
                let _ = main.set_focus();
            }
        }
        let _ = app.emit_to("main", "web-key", json!({ "key": key, "text": text, "source": source, "url": page }));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_can_ask_for_listed_shortcuts_only() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert_eq!(shortcut(&url("https://bridgedeck.invalid/key?k=search")), Some(("search".into(), String::new())));
        assert_eq!(shortcut(&url("https://bridgedeck.invalid/key?k=ask&t=chain%20rule")), Some(("ask".into(), "chain rule".into())));
        assert_eq!(shortcut(&url("https://bridgedeck.invalid/key?k=rm-rf")), None);
        assert_eq!(shortcut(&url("https://bridgedeck.invalid/chatgpt-save?k=search")), None);
        assert_eq!(shortcut(&url("https://example.org/key?k=search")), None);
        let long = format!("https://bridgedeck.invalid/key?k=ask&t={}", "a".repeat(5000));
        assert_eq!(shortcut(&url(&long)).unwrap().1.len(), MAX_TEXT);
    }
}
