//! Where native pages (the Browser and TV tabs' websites, the ChatGPT panel) sit in BridgeDeck's
//! window. BridgeDeck's own page says where, in its own coordinates; this puts the native page
//! exactly there.
//!
//! On macOS the two don't share a starting point: BridgeDeck's page can sit under the title bar
//! with its contents moved down below it, while a native page placed at the same numbers lands a
//! title bar higher. Rather than guess from window sizes (which report differently from Mac to
//! Mac), each placement is checked: macOS is asked where the page actually landed and where the
//! window's usable area (below the title bar) starts, and the difference is corrected, then kept
//! for later placements. On Windows and Linux the numbers already match.

use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize};

/// Learned on macOS: added to every requested position (logical points).
static CORRECTION: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0));

/// Where to put a native page that BridgeDeck's page wants at `x, y` (`w × h`).
pub fn bounds(x: f64, y: f64, w: f64, h: f64) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let (dx, dy) = CORRECTION.lock().map(|c| *c).unwrap_or((0.0, 0.0));
    (LogicalPosition::new(x.max(0.0) + dx, y.max(0.0) + dy), LogicalSize::new(w.max(1.0), h.max(1.0)))
}

/// The correction that moves a page from where it landed to where it was wanted. Off by more than
/// a title bar and a bit is not a placement error to learn from (a page mid-animation, a stale
/// reading), so it's ignored.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn learn(current: (f64, f64), wanted: (f64, f64), landed: (f64, f64)) -> Option<(f64, f64)> {
    let (ex, ey) = (landed.0 - wanted.0, landed.1 - wanted.1);
    if ex.abs() < 0.5 && ey.abs() < 0.5 {
        return None;
    }
    if ex.abs() > 120.0 || ey.abs() > 120.0 || !ex.is_finite() || !ey.is_finite() {
        return None;
    }
    Some((current.0 - ex, current.1 - ey))
}

/// macOS: checks where the native page `label` landed, and if it isn't at `x, y` in BridgeDeck's
/// page, corrects it (and remembers the correction). Elsewhere, nothing to do.
pub fn verify(app: &AppHandle, label: &str, x: f64, y: f64) {
    #[cfg(target_os = "macos")]
    macos::verify(app, label, x.max(0.0), y.max(0.0));
    #[cfg(not(target_os = "macos"))]
    let _ = (app, label, x, y);
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2_app_kit::NSView;
    use tauri::Manager;

    /// Top-left of a view, and of its window's usable area below the title bar, in window
    /// coordinates (points, measured up from the bottom).
    unsafe fn view_and_area(ptr: *mut std::ffi::c_void) -> Option<((f64, f64), (f64, f64))> {
        let view: &NSView = (ptr as *const NSView).as_ref()?;
        let window = view.window()?;
        let r = view.convertRect_toView(view.bounds(), None);
        let area = window.contentLayoutRect();
        Some(((r.origin.x, r.origin.y + r.size.height), (area.origin.x, area.origin.y + area.size.height)))
    }

    pub fn verify(app: &AppHandle, label: &str, x: f64, y: f64) {
        let Some(view) = app.get_webview(label) else { return };
        let (app, label) = (app.clone(), label.to_string());
        // Runs on the main thread, where AppKit may be asked.
        let _ = view.with_webview(move |page| {
            let Some(((left, top), (area_left, area_top))) = (unsafe { view_and_area(page.inner()) }) else { return };
            // Where it landed, in BridgeDeck's page terms: across from the area's left, down from its top.
            let landed = (left - area_left, area_top - top);
            let Ok(mut correction) = CORRECTION.lock() else { return };
            let Some(next) = learn(*correction, (x, y), landed) else { return };
            *correction = next;
            let to = LogicalPosition::new(x + next.0, y + next.1);
            // Moved from another thread: this one is busy running the check.
            std::thread::spawn(move || {
                if let Some(view) = app.get_webview(&label) {
                    let _ = view.set_position(to);
                }
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_a_title_bar_too_high_is_moved_down_and_remembered() {
        // Wanted 93 down; landed 65 down (28 too high): correct by +28.
        assert_eq!(learn((0.0, 0.0), (0.0, 93.0), (0.0, 65.0)), Some((0.0, 28.0)));
        // With that correction it lands right: nothing more to learn.
        assert_eq!(learn((0.0, 28.0), (0.0, 93.0), (0.0, 93.2)), None);
        // A wild reading isn't learned from.
        assert_eq!(learn((0.0, 0.0), (0.0, 93.0), (0.0, 900.0)), None);
    }
}
