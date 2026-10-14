//! A log of crashes and errors on this computer (`<app data>/errors.log`): Rust panics, with where
//! they happened, and errors the window reports (uncaught exceptions, rejected promises). Settings
//! shows it and copies it as a report to paste when something goes wrong.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

const FILE: &str = "errors.log";
/// There while BridgeDeck runs; still there at the next start means it didn't close normally (a
/// crash in the web view or the system, which never reaches the panic hook, or a force quit).
const RUNNING: &str = "running";
const OLD: &str = "errors.old.log";
/// The log starts over (keeping one older copy) past this size.
const MAX_BYTES: u64 = 512 * 1024;
/// How much of the log a report includes.
const REPORT_BYTES: usize = 48 * 1024;

static PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITING: Mutex<()> = Mutex::new(());

/// Remembers where the log goes and records panics from now on (after the default handler runs).
pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = PATH.set(dir.join(FILE));
        let marker = dir.join(RUNNING);
        if marker.exists() {
            record("unclean-exit", "BridgeDeck didn't close normally last time: it crashed, was force-quit, or the computer shut down or restarted while it was open.");
        }
        let _ = fs::write(&marker, std::process::id().to_string());
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_else(|| "unknown place".into());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".into());
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        record("crash", &format!("panic in thread {thread} at {place}: {message}"));
        previous(info);
    }));
}

/// BridgeDeck is closing normally.
pub fn closed() {
    if let Some(path) = PATH.get() {
        let _ = fs::remove_file(path.with_file_name(RUNNING));
    }
}

/// One line (or a few, indented) in the log, with the time and where it came from.
pub fn record(source: &str, message: &str) {
    let Some(path) = PATH.get() else { return };
    // A panic while writing must not panic again; a poisoned lock still guards the file.
    let _guard = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    if fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::rename(path, path.with_file_name(OLD));
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else { return };
    let _ = writeln!(file, "{}", entry(&crate::diagnostics::now_text(), source, message));
    drop(_guard);
    // Every error and crash is in the activity log too, among what was going on at the time.
    let kind = if source == "crash" || source == "unclean-exit" { crate::activity::Kind::Crash } else { crate::activity::Kind::Error };
    crate::activity::record(kind, source, message);
}

fn entry(time: &str, source: &str, message: &str) -> String {
    let source: String = source.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(20).collect();
    let message: String = message.trim().chars().take(4000).collect();
    format!("[{time}] {source}: {}", message.replace('\n', "\n    "))
}

/// The end of the log (whole lines), newest last.
fn tail(text: &str, bytes: usize) -> &str {
    if text.len() <= bytes {
        return text;
    }
    let mut start = text.len() - bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    match text[start..].find('\n') {
        Some(i) => &text[start + i + 1..],
        None => &text[start..],
    }
}

fn read_all() -> String {
    let Some(path) = PATH.get() else { return String::new() };
    let old = fs::read_to_string(path.with_file_name(OLD)).unwrap_or_default();
    old + &fs::read_to_string(path).unwrap_or_default()
}

/// The last part of the log, for the diagnostics report.
pub fn recent(bytes: usize) -> String {
    tail(&read_all(), bytes).to_string()
}

#[derive(serde::Serialize)]
pub struct ErrorLog {
    pub text: String,
    pub entries: usize,
    pub crashes: usize,
    pub path: String,
}

#[tauri::command]
pub fn error_log_read() -> ErrorLog {
    let all = read_all();
    let text = tail(&all, REPORT_BYTES).to_string();
    ErrorLog {
        entries: text.lines().filter(|l| l.starts_with('[')).count(),
        crashes: text.lines().filter(|l| l.starts_with('[') && l.contains("] crash:")).count(),
        text,
        path: PATH.get().map(|p| p.display().to_string()).unwrap_or_default(),
    }
}

/// An error from the window (it can't write files itself).
#[tauri::command]
pub fn error_log_add(source: String, message: String) {
    record(if source.is_empty() { "window" } else { &source }, &message);
}

#[tauri::command]
pub fn error_log_clear() -> Result<(), String> {
    let Some(path) = PATH.get() else { return Ok(()) };
    let _guard = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    for file in [path.clone(), path.with_file_name(OLD)] {
        match fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_are_one_block_each() {
        assert_eq!(entry("2026-10-07 12:00 UTC", "window", "TypeError: x\n  at f"), "[2026-10-07 12:00 UTC] window: TypeError: x\n      at f");
        assert_eq!(entry("t", "we ird\n", "m"), "[t] weird: m");
    }

    #[test]
    fn tail_keeps_whole_lines() {
        let text = "[a] one\n[b] two\n[c] three\n";
        assert_eq!(tail(text, 100), text);
        assert_eq!(tail(text, 12), "[c] three\n");
        assert_eq!(tail("ééééé\nlast\n", 7), "last\n");
    }
}
