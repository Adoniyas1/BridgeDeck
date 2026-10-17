//! A development build (`npm run tauri dev`) shows its interface from the dev server on
//! localhost:1420. Started any other way (an old shortcut to `target\debug`), there's no server and
//! the window would show only "localhost refused to connect". Then this opens the installed
//! BridgeDeck instead and closes, or, with none installed, says what happened.

use std::{net::TcpStream, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

/// localhost:1420, either way it resolves.
const DEV_SERVER: &[&str] = &["127.0.0.1:1420", "[::1]:1420"];

/// The installed app, if there is one (not this program).
fn installed() -> Option<PathBuf> {
    let path = if cfg!(windows) {
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("BridgeDeck").join("bridgedeck.exe")
    } else if cfg!(target_os = "macos") {
        PathBuf::from("/Applications/BridgeDeck.app")
    } else {
        return None;
    };
    let me = std::env::current_exe().ok()?;
    (path.exists() && !me.starts_with(&path)).then_some(path)
}

fn open(path: &PathBuf) -> std::io::Result<std::process::Child> {
    if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(path).spawn()
    } else {
        std::process::Command::new(path).spawn()
    }
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>BridgeDeck</title><body style=\"font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"max-width:520px;padding:24px\"><h2 style=\"margin:0 0 8px\">This is BridgeDeck's development build</h2><p>It shows its screens from the development server, which isn't running. This usually means a shortcut points to the build in <code>src-tauri\\target\\debug</code>.</p><p>Install BridgeDeck (run <code>npm run tauri build</code>, then the installer in <code>src-tauri\\target\\release\\bundle</code>) and use the shortcut it makes, or start this one with <code>npm run tauri dev</code>.</p></div></body>";

pub fn check(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // A few seconds' grace, for a dev server still starting.
        for _ in 0..10 {
            if DEV_SERVER.iter().any(|a| a.parse().is_ok_and(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok())) {
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if let Some(path) = installed() {
            if open(&path).is_ok() {
                crate::activity::warn("app", &format!("Started as a development build with no dev server: opened the installed BridgeDeck ({}) instead.", path.display()));
                app.exit(0);
                return;
            }
        }
        crate::activity::warn("app", "Started as a development build with no dev server running.");
        if let Some(window) = app.webview_windows().values().next() {
            let url = format!("data:text/html;charset=utf-8,{}", urlencoding(PAGE));
            if let Ok(url) = url.parse() {
                let _ = window.navigate(url);
            }
        }
    });
}

fn urlencoding(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~ ".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>().replace(' ', "%20")
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_page_is_url_safe() {
        let e = super::urlencoding(super::PAGE);
        assert!(!e.contains(['<', '>', '"', ' ', '#', '\\'].as_slice()));
        assert_eq!(super::urlencoding("a b%"), "a%20b%25");
    }
}
