//! What the Home tab's "Needs attention" card asks the system: permissions macOS grants per app, and
//! a way to open the right Privacy & Security pane.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    /// None where the system doesn't ask (not a Mac).
    pub screen_recording: Option<bool>,
    pub accessibility: Option<bool>,
}

#[cfg(target_os = "macos")]
mod mac {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> u8;
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }

    /// Checks without prompting.
    pub fn screen_recording() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() != 0 }
    }

    pub fn accessibility() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }
}

#[tauri::command]
pub fn health_permissions() -> Permissions {
    #[cfg(target_os = "macos")]
    return Permissions { screen_recording: Some(mac::screen_recording()), accessibility: Some(mac::accessibility()) };
    #[cfg(not(target_os = "macos"))]
    Permissions { screen_recording: None, accessibility: None }
}

/// The System Settings pane for one permission (macOS only).
fn privacy_url(pane: &str) -> Option<&'static str> {
    Some(match pane {
        "screen" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "accessibility" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        "files" => "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        "automation" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
        _ => return None,
    })
}

#[tauri::command]
pub fn open_privacy_settings(app: AppHandle, pane: String) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Only macOS has these settings".into());
    }
    let url = privacy_url(&pane).ok_or("Unknown settings pane")?;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_panes_open() {
        assert!(privacy_url("files").unwrap().ends_with("Privacy_AllFiles"));
        assert!(privacy_url("x-apple.systempreferences:anything").is_none());
    }
}
