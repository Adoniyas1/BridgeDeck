//! Apps older BridgeDeck versions depended on: RustDesk (remote control) and BlueBubbles (iMessage).
//! BridgeDeck now does both itself, but those apps keep starting at login until they're removed.
//! This finds them and, when the person asks, quits them and stops them from starting at login.
//! Uninstalling stays with the person: RustDesk's system service needs an administrator to remove.

use serde::Serialize;
use std::{path::PathBuf, process::Command, time::Duration};

struct Known {
    name: &'static str,
    /// Lower-case start of the process name.
    process: &'static str,
    replaced_by: &'static str,
}

const KNOWN: &[Known] = &[
    Known { name: "RustDesk", process: "rustdesk", replaced_by: "the Remote tab" },
    Known { name: "BlueBubbles", process: "bluebubbles", replaced_by: "the Messages tab" },
];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyApp {
    pub name: String,
    pub replaced_by: String,
    pub running: bool,
    pub starts_at_login: bool,
    pub installed: bool,
    /// A system service (RustDesk) that only an administrator can remove.
    pub system_service: bool,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn processes(prefix: &str) -> Vec<sysinfo::Pid> {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let own = sysinfo::get_current_pid().ok();
    system
        .processes()
        .iter()
        .filter(|(pid, p)| Some(**pid) != own && p.name().to_string_lossy().to_ascii_lowercase().starts_with(prefix))
        .map(|(pid, _)| *pid)
        .collect()
}

fn kill(prefix: &str) {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    for pid in processes(prefix) {
        if let Some(process) = system.process(pid) {
            process.kill();
        }
    }
}

/// Files in a folder whose name contains `needle` (case-insensitive).
fn matching_files(dir: PathBuf, needle: &str) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().contains(needle))).collect())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub fn installed(app: &Known) -> bool {
        [PathBuf::from("/Applications"), home().join("Applications")].iter().any(|dir| dir.join(format!("{}.app", app.name)).exists())
    }

    fn user_agents(app: &Known) -> Vec<PathBuf> {
        matching_files(home().join("Library/LaunchAgents"), app.process)
    }

    pub fn starts_at_login(app: &Known) -> bool {
        !user_agents(app).is_empty()
    }

    /// Installed for all users (RustDesk's installer does this); launchd restarts it after a quit.
    pub fn system_service(app: &Known) -> bool {
        ["/Library/LaunchDaemons", "/Library/LaunchAgents"].iter().any(|dir| !matching_files(PathBuf::from(dir), app.process).is_empty())
    }

    pub fn stop(app: &Known) {
        let _ = command("/usr/bin/osascript").args(["-e", &format!("tell application \"{}\" to quit", app.name)]).output();
        std::thread::sleep(Duration::from_secs(1));
        kill(app.process);
        // Login items added in System Settings (asks once to allow controlling System Events).
        let _ = command("/usr/bin/osascript")
            .args(["-e", &format!("tell application \"System Events\" to delete (every login item whose name contains \"{}\")", app.name)])
            .output();
        // The app's own launch agent in this user's Library: disable it (the file stays).
        for plist in user_agents(app) {
            let _ = command("/bin/launchctl").arg("unload").arg("-w").arg(&plist).output();
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

    pub fn installed(app: &Known) -> bool {
        let dirs = ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|v| std::env::var_os(v).map(PathBuf::from))
            .chain(std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Programs")));
        dirs.into_iter().any(|dir| !matching_files(dir, app.process).is_empty())
    }

    fn run_values(app: &Known) -> Vec<String> {
        let Ok(output) = command("reg").args(["query", RUN_KEY]).output() else { return Vec::new() };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_once("    REG_").map(|(name, _)| name.trim().to_string()))
            .filter(|name| name.to_ascii_lowercase().contains(app.process))
            .collect()
    }

    fn startup_shortcuts(app: &Known) -> Vec<PathBuf> {
        std::env::var_os("APPDATA")
            .map(|d| matching_files(PathBuf::from(d).join(r"Microsoft\Windows\Start Menu\Programs\Startup"), app.process))
            .unwrap_or_default()
    }

    pub fn starts_at_login(app: &Known) -> bool {
        !run_values(app).is_empty() || !startup_shortcuts(app).is_empty()
    }

    pub fn system_service(app: &Known) -> bool {
        command("sc").args(["query", app.name]).output().map(|o| o.status.success()).unwrap_or(false)
    }

    pub fn stop(app: &Known) {
        kill(app.process);
        for value in run_values(app) {
            let _ = command("reg").args(["delete", RUN_KEY, "/v", &value, "/f"]).output();
        }
        for shortcut in startup_shortcuts(app) {
            let _ = std::fs::remove_file(shortcut);
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    pub fn installed(_: &Known) -> bool {
        false
    }
    pub fn starts_at_login(_: &Known) -> bool {
        false
    }
    pub fn system_service(_: &Known) -> bool {
        false
    }
    pub fn stop(app: &Known) {
        kill(app.process);
    }
}

fn scan() -> Vec<LegacyApp> {
    KNOWN
        .iter()
        .map(|app| LegacyApp {
            name: app.name.into(),
            replaced_by: app.replaced_by.into(),
            running: !processes(app.process).is_empty(),
            starts_at_login: platform::starts_at_login(app),
            installed: platform::installed(app),
            system_service: platform::system_service(app),
        })
        .filter(|app| app.running || app.starts_at_login || app.installed || app.system_service)
        .collect()
}

/// Leftover apps found on this computer (empty when there are none).
#[tauri::command]
pub async fn legacy_apps() -> Vec<LegacyApp> {
    tauri::async_runtime::spawn_blocking(scan).await.unwrap_or_default()
}

/// Quits the leftover apps and stops them starting at login; returns what's still there.
#[tauri::command]
pub async fn legacy_apps_stop() -> Vec<LegacyApp> {
    tauri::async_runtime::spawn_blocking(|| {
        for app in KNOWN {
            platform::stop(app);
        }
        std::thread::sleep(Duration::from_millis(500));
        scan()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_files_by_name_and_skips_this_process() {
        let dir = std::env::temp_dir().join(format!("bd-legacy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("com.carriez.RustDesk_server.plist"), "").unwrap();
        std::fs::write(dir.join("other.plist"), "").unwrap();
        assert_eq!(matching_files(dir.clone(), "rustdesk").len(), 1);
        assert!(matching_files(dir.join("missing"), "rustdesk").is_empty());
        let _ = std::fs::remove_dir_all(dir);
        // The test binary is never reported as one of the apps.
        let own = sysinfo::get_current_pid().unwrap();
        assert!(!processes("bridgedeck").contains(&own));
    }
}
