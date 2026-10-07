//! "Copy diagnostics": one text report about this computer and every paired one, to paste when
//! something doesn't work. It says what BridgeDeck can see (versions, pairing, updates, Mimir, sync,
//! files, clipboard, remote control) and leaves out what's private: no message text, file names
//! from transfers, passwords, keys or tokens (long tokens are masked as a last line of defence).

use crate::bridgelink::BridgeLinkManager;
use std::fmt::Write as _;
use tauri::{AppHandle, Manager};

/// Masks anything that looks like a key, token or fingerprint: runs of 32+ letters, digits, `-`, `_`.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.chars().count() >= 32 {
            out.extend(run.chars().take(4));
            out.push_str("…[hidden]");
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

fn yes(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

/// This computer's part of the report.
pub fn local_report(app: &AppHandle) -> String {
    let mut r = String::new();
    let link = crate::bridgelink::bridgelink_status(app.state::<BridgeLinkManager>()).ok();
    let name = link.as_ref().map(|l| l.display_name.clone()).unwrap_or_default();
    let _ = writeln!(r, "=== {name} ({} {}) ===", std::env::consts::OS, std::env::consts::ARCH);
    let _ = writeln!(
        r,
        "BridgeDeck {} · {} · {} build · OS {}",
        env!("CARGO_PKG_VERSION"),
        crate::upgrade::git_summary().unwrap_or_else(|| "not a git clone".into()),
        if cfg!(debug_assertions) { "dev (npm run tauri dev)" } else { "installed" },
        sysinfo::System::long_os_version().unwrap_or_default(),
    );

    let _ = writeln!(r, "\n[Pairing]");
    match &link {
        Some(l) => {
            let _ = writeln!(r, "running: {} · tailscale: {} · discovered: {} · waiting: {}", yes(l.running), yes(l.tailscale), l.discovered.len(), l.pending.len());
            for p in &l.paired {
                let _ = writeln!(r, "paired: {} ({}, via {}, {} addresses, wake-on-LAN: {})", p.name, p.platform, p.via, p.addresses.len(), yes(p.wakeable));
            }
            if !l.legacy.is_empty() {
                let _ = writeln!(r, "needs pairing again: {}", l.legacy.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "));
            }
            if let Some(detail) = &l.detail {
                let _ = writeln!(r, "detail: {detail}");
            }
        }
        None => {
            let _ = writeln!(r, "status unavailable");
        }
    }

    let upgrade = crate::upgrade::info(app);
    let _ = writeln!(r, "\n[Updates]");
    let _ = writeln!(r, "git ready: {} · last update: {} / {} — {}", yes(upgrade.git_ready), upgrade.status.state, upgrade.status.stage, upgrade.status.message);

    let mimir = crate::mimir_host::status();
    let _ = writeln!(r, "\n[Mimir]");
    let _ = writeln!(r, "phase: {:?} · {} · in this source folder: {}", mimir.phase, mimir.detail, yes(mimir.available));
    for line in mimir.log.iter().rev().take(15).rev() {
        let _ = writeln!(r, "  | {line}");
    }

    let sidecar = crate::sync_sidecar::sync_sidecar_status(app.clone(), app.state()).ok();
    let _ = writeln!(r, "\n[Sync]");
    match sidecar {
        Some(s) => {
            let _ = writeln!(r, "built-in Syncthing: available {} · running {} · {}", yes(s.available), yes(s.running), s.detail);
        }
        None => {
            let _ = writeln!(r, "status unavailable");
        }
    }

    let files = crate::localsend_bridge::localsend_receiver_status(app.state()).ok();
    let _ = writeln!(r, "\n[Files]");
    match files {
        Some(f) => {
            let _ = writeln!(r, "receiving: {} on port {} · waiting for Accept: {} · recent transfers: {}", yes(f.running), f.port, yes(f.pending.is_some()), f.recent.len());
        }
        None => {
            let _ = writeln!(r, "status unavailable");
        }
    }

    let clipboard = crate::clipboard::status();
    let _ = writeln!(r, "\n[Clipboard]");
    let _ = writeln!(r, "sharing: {} · clipboard opened: {} · last: {}", yes(clipboard.enabled), yes(clipboard.available), clipboard.last.as_ref().map(|a| format!("{} {} ({})", a.direction, a.kind, a.peers.join(", "))).unwrap_or_else(|| "none".into()));
    for error in &clipboard.errors {
        let _ = writeln!(r, "  error: {error}");
    }

    let remote = crate::remote::host::status();
    let _ = writeln!(r, "\n[Remote control]");
    let _ = writeln!(r, "can be controlled: {} · allowed: {} · ask first: {} · sessions now: {}", yes(remote.supported), yes(remote.settings.allow), yes(remote.settings.ask_first), remote.sessions.len());

    if crate::imessage::available() {
        let _ = writeln!(r, "\n[Messages]");
        match crate::imessage::handle(crate::imessage::Op::Status) {
            Ok(value) => {
                let _ = writeln!(r, "available: {} · {}", value.get("available").and_then(|v| v.as_bool()).map(yes).unwrap_or("?"), value.get("detail").and_then(|v| v.as_str()).unwrap_or(""));
            }
            Err(error) => {
                let _ = writeln!(r, "error: {error}");
            }
        }
    }

    let errors = crate::errorlog::recent(6 * 1024);
    if !errors.trim().is_empty() {
        let _ = writeln!(r, "\n[Recent errors]\n{}", errors.trim_end());
    }
    redact(&r)
}

/// This computer's report followed by each paired computer's.
#[tauri::command]
pub async fn diagnostics_report(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<BridgeLinkManager>().inner().clone();
        let mut report = format!("BridgeDeck diagnostics, {}\n\n", chrono_like_now());
        report.push_str(&local_report(&app));
        for (id, name) in crate::bridgelink::peer::paired_peers(&manager) {
            report.push('\n');
            match crate::bridgelink::peer::peer_diagnostics(&manager, &id) {
                Ok(text) => report.push_str(&redact(&text)),
                Err(error) => {
                    let _ = writeln!(report, "=== {name} ===\ncouldn't get its report: {}", redact(&error));
                }
            }
        }
        report
    })
    .await
    .map_err(|e| e.to_string())
}

/// UTC time as "2026-10-01 14:05 UTC" without a date crate.
pub fn now_text() -> String {
    chrono_like_now()
}

fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02} UTC", rem / 3600, (rem % 3600) / 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_tokens_are_masked_but_ordinary_text_is_kept() {
        let text = "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and 3f2a9c1e0b7d4e8f9a6b5c4d3e2f1a0b9c8d7e6f; name Mac mini, port 41416";
        let masked = redact(text);
        assert!(masked.contains("sk-a…[hidden]"));
        assert!(masked.contains("3f2a…[hidden]"));
        assert!(masked.contains("name Mac mini, port 41416"));
        assert!(!masked.contains("abcdefghijklmnop"));
    }

    #[test]
    fn the_date_is_formatted_from_the_clock() {
        let now = chrono_like_now();
        assert!(now.ends_with(" UTC") && now.len() == "2026-10-01 14:05 UTC".len(), "{now}");
        assert!(now.starts_with("20"));
    }
}
