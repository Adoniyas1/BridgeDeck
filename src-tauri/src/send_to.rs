//! "Send to BridgeDeck" from the file manager. On Windows, a shortcut in Explorer's Send to menu
//! starts BridgeDeck with `--send <paths>`; the running BridgeDeck receives them (single instance).
//! On the Mac, BridgeDeck is listed under Open With and accepts files dropped on its Dock icon.
//! Either way the files wait in the Files tab for the user to pick a computer.

use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime};

pub const FLAG: &str = "--send";

static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The existing files and folders after `--send` on a command line.
pub fn paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter().skip_while(|a| a != FLAG).skip(1).filter(|p| Path::new(p).exists()).collect()
}

/// Queues files for the Files tab and brings BridgeDeck forward.
pub fn deliver<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).extend(paths);
    crate::tray::show_main(app);
    // The UI may not have loaded yet (BridgeDeck was started by Send to); it asks for the queue then.
    let _ = app.emit("send-files", ());
}

#[tauri::command]
pub fn send_files_pending() -> Vec<String> {
    std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    /// "send-to" (Windows Explorer), "open-with" (macOS Finder) or "" (none).
    pub kind: &'static str,
    pub installed: bool,
}

/// Adds or removes the Send to entry (Windows). The Mac's Open With entry comes with the app.
#[tauri::command]
pub async fn send_to_integration(enabled: bool) -> Result<Integration, String> {
    tauri::async_runtime::spawn_blocking(move || platform::set(enabled)).await.map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
mod platform {
    use super::Integration;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn shortcut() -> Option<PathBuf> {
        std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join(r"Microsoft\Windows\SendTo\BridgeDeck.lnk"))
    }

    pub fn set(enabled: bool) -> Result<Integration, String> {
        let link = shortcut().ok_or("APPDATA is not set")?;
        if !enabled {
            if link.exists() {
                std::fs::remove_file(&link).map_err(|e| e.to_string())?;
            }
            return Ok(Integration { kind: "send-to", installed: false });
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // Rewritten each start so it follows BridgeDeck when it moves (or a new build runs).
        let script = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BD_LINK); $s.TargetPath = $env:BD_EXE; $s.Arguments = '--send'; $s.IconLocation = $env:BD_EXE; $s.Description = 'Send to another computer with BridgeDeck'; $s.Save()";
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
            .env("BD_LINK", &link)
            .env("BD_EXE", &exe)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() || !link.exists() {
            return Err("Could not add BridgeDeck to the Send to menu".into());
        }
        Ok(Integration { kind: "send-to", installed: true })
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Integration;

    pub fn set(_enabled: bool) -> Result<Integration, String> {
        Ok(Integration { kind: "open-with", installed: true })
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::Integration;

    pub fn set(_enabled: bool) -> Result<Integration, String> {
        Ok(Integration { kind: "", installed: false })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_paths_after_the_flag_are_taken() {
        let here = env!("CARGO_MANIFEST_DIR").to_string();
        let args = ["bridgedeck", "--other", FLAG, &here, "/no/such/file"].map(String::from);
        assert_eq!(paths_from_args(args), vec![here]);
        assert!(paths_from_args(["bridgedeck".to_string()]).is_empty());
    }
}
