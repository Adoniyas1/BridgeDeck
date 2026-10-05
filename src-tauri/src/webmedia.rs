//! Video in web pages (Browser and TV tabs): full screen from a site's own player, and pausing.
//!
//! macOS: WebKit's element full screen is turned on for these pages, so a player's full-screen button
//! takes the video to the whole screen as in Safari. Windows: WebView2 only says a page wants full
//! screen; BridgeDeck is told ("web-fullscreen") and fills the screen with the page itself.

use tauri::{AppHandle, Manager};

/// Pauses every video and sound on the page (its top frame).
pub const PAUSE_MEDIA: &str = "document.querySelectorAll('video,audio').forEach(function(m){try{m.pause()}catch(e){}})";

/// Sets up a newly created browser or TV page for full-screen video.
pub fn setup(app: &AppHandle, label: &str) {
    let Some(view) = app.get_webview(label) else { return };
    #[cfg(target_os = "macos")]
    {
        let _ = view.with_webview(|page| unsafe {
            let webview: &objc2_web_kit::WKWebView = &*(page.inner() as *const objc2_web_kit::WKWebView);
            webview.configuration().preferences().setElementFullscreenEnabled(true);
        });
    }
    #[cfg(windows)]
    {
        use serde_json::json;
        use tauri::Emitter;
        use webview2_com::ContainsFullScreenElementChangedEventHandler;
        let (app, label) = (app.clone(), label.to_string());
        let _ = view.with_webview(move |page| unsafe {
            let Ok(webview) = page.controller().CoreWebView2() else { return };
            let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                let Some(sender) = sender else { return Ok(()) };
                let mut on = windows::core::BOOL::default();
                sender.ContainsFullScreenElement(&mut on)?;
                // The window goes full screen, and BridgeDeck hides its bars so the page fills it.
                if let Some(window) = app.get_window("main") {
                    let _ = window.set_fullscreen(on.as_bool());
                }
                let _ = app.emit_to("main", "web-fullscreen", json!({ "label": label, "on": on.as_bool() }));
                Ok(())
            }));
            let mut token = 0i64;
            let _ = webview.add_ContainsFullScreenElementChanged(&handler, &mut token);
        });
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = view;
}
