//! The activity log (`<app data>/activity.log`): what BridgeDeck does, as it does it, one line each:
//! starting and closing, the computer it's on, the actions the window takes (saving, sending, running
//! code…), the safety stop, and every error and crash (errors.log keeps those on their own too).
//! Settings → Activity shows it, filtered and searchable, with Mimir's crashes alongside.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

const FILE: &str = "activity.log";
const OLD: &str = "activity.old.log";
/// The log starts over (keeping one older copy) past this size.
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const READ_BYTES: usize = 256 * 1024;

static PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITING: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Info,
    Warn,
    Error,
    Crash,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Info => "INFO",
            Kind::Warn => "WARN",
            Kind::Error => "ERROR",
            Kind::Crash => "CRASH",
        }
    }
    fn parse(text: &str) -> Kind {
        match text.to_ascii_lowercase().as_str() {
            "warn" | "warning" => Kind::Warn,
            "error" => Kind::Error,
            "crash" => Kind::Crash,
            _ => Kind::Info,
        }
    }
}

pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = PATH.set(dir.join(FILE));
    }
}

/// One entry: the time, how serious it is, where it came from and what happened.
pub fn record(kind: Kind, source: &str, message: &str) {
    let Some(path) = PATH.get() else { return };
    let _guard = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    if fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::rename(path, path.with_file_name(OLD));
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else { return };
    let _ = writeln!(file, "{}", line(&crate::diagnostics::now_text_seconds(), kind, source, message));
}

pub fn info(source: &str, message: &str) {
    record(Kind::Info, source, message);
}

pub fn warn(source: &str, message: &str) {
    record(Kind::Warn, source, message);
}

fn line(time: &str, kind: Kind, source: &str, message: &str) -> String {
    let source: String = source.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).take(24).collect();
    let message: String = message.trim().chars().take(4000).collect();
    format!("[{time}] {:<5} {source}: {}", kind.label(), message.replace('\n', "\n    "))
}

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

/// Mimir's own logs (it runs as a separate program): its crashes, and what its load watch did
/// (easing models off the GPU).
fn mimir_crashes() -> String {
    let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) else { return String::new() };
    let dir = PathBuf::from(home).join(".mimir").join("logs");
    let mut out = String::new();
    for (file, title) in [("activity.log", "Mimir's activity"), ("crash.log", "Mimir's crashes and errors")] {
        let text = fs::read_to_string(dir.join(file)).unwrap_or_default();
        if !text.trim().is_empty() {
            out.push_str(&format!("== {title} ==\n{}\n", tail(&text, 32 * 1024).trim_end()));
        }
    }
    out
}

/// Mimir's speed log (each answer's tokens per second) and its activity log (where the load watch
/// notes GPU share changes), for the AI speed chart.
#[derive(serde::Serialize)]
pub struct AiSpeedLog {
    pub speed: String,
    pub activity: String,
}

#[tauri::command]
pub fn ai_speed_log() -> AiSpeedLog {
    let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) else { return AiSpeedLog { speed: String::new(), activity: String::new() } };
    let dir = PathBuf::from(home).join(".mimir").join("logs");
    let read = |f: &str, bytes: usize| tail(&fs::read_to_string(dir.join(f)).unwrap_or_default(), bytes).to_string();
    AiSpeedLog { speed: read("speed.log", 96 * 1024), activity: read("activity.log", 64 * 1024) }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLog {
    pub text: String,
    pub mimir: String,
    pub path: String,
}

#[tauri::command]
pub fn activity_read() -> ActivityLog {
    let Some(path) = PATH.get() else { return ActivityLog { text: String::new(), mimir: mimir_crashes(), path: String::new() } };
    let all = fs::read_to_string(path.with_file_name(OLD)).unwrap_or_default() + &fs::read_to_string(path).unwrap_or_default();
    ActivityLog { text: tail(&all, READ_BYTES).to_string(), mimir: mimir_crashes(), path: path.display().to_string() }
}

#[derive(serde::Deserialize)]
pub struct Entry {
    pub kind: String,
    pub source: String,
    pub message: String,
}

/// Entries from the window, sent a few at a time.
#[tauri::command]
pub fn activity_add(entries: Vec<Entry>) {
    for e in entries.into_iter().take(200) {
        record(Kind::parse(&e.kind), if e.source.is_empty() { "window" } else { &e.source }, &e.message);
    }
}

#[tauri::command]
pub fn activity_clear() -> Result<(), String> {
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
    fn lines_have_time_kind_source_and_indented_continuations() {
        assert_eq!(line("2026-10-13 23:50:01", Kind::Warn, "safety stop!", "low memory\nstopped the AI"), "[2026-10-13 23:50:01] WARN  safetystop: low memory\n    stopped the AI");
        assert_eq!(Kind::parse("ERROR"), Kind::Error);
        assert_eq!(Kind::parse("whatever"), Kind::Info);
        assert_eq!(tail("one\ntwo\nthree\n", 8), "three\n");
    }
}
