//! Handwriting (pen, Apple Pencil) in notes. An ink block's text is the ink's id; the ink is the
//! folder `<shared folder>/Ink/<id>/`:
//!
//! - `doc.json`: the page setup (paper, size, pages, PDF backgrounds), replaced as a whole;
//! - `strokes-<device>.jsonl`: each computer's (or the iPad's) strokes and erasures, one JSON object a
//!   line, only ever appended to by that device, so syncing never conflicts. A last line cut off by
//!   a sync in progress is skipped by readers (src/features/notes/ink/model.ts).
//! - `bg/<page>.png`: page backgrounds (a PDF's pages, drawn once on the desktop).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::bridgelink::BridgeLinkManager;

const MAX_DOC: usize = 256 * 1024;
const MAX_LINE: usize = 512 * 1024;
const MAX_LOG: u64 = 64 * 1024 * 1024;
const MAX_BACKGROUND: usize = 12 * 1024 * 1024;

pub fn folder_in(shared: &Path, id: &str) -> Result<PathBuf, String> {
    if !crate::drawings::valid_id(id) {
        return Err("Not an ink id".into());
    }
    Ok(shared.join("Ink").join(id))
}

fn folder(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let shared = crate::shared_folder(app);
    let shared = if shared.trim().is_empty() { crate::study::default_shared() } else { PathBuf::from(shared.trim()) };
    folder_in(&shared, id)
}

/// A device id as part of a file name.
fn device_name(device: &str) -> String {
    let safe: String = device.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(64).collect();
    if safe.is_empty() { "unknown".into() } else { safe }
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let part = path.with_extension("partial");
    fs::write(&part, data).and_then(|_| fs::rename(&part, path)).map_err(|e| e.to_string())
}

pub fn set_doc(dir: &Path, doc: &str) -> Result<(), String> {
    if doc.len() > MAX_DOC || !serde_json::from_str::<serde_json::Value>(doc).is_ok_and(|v| v.is_object()) {
        return Err("Not an ink page setup".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("doc.json"), doc.as_bytes())
}

/// Appends lines (JSON objects, one stroke or erasure each) to this device's log.
pub fn append(dir: &Path, device: &str, lines: &[String]) -> Result<(), String> {
    if lines.iter().any(|l| l.len() > MAX_LINE || l.contains('\n') || !l.trim_start().starts_with('{')) {
        return Err("Not ink strokes".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("strokes-{}.jsonl", device_name(device)));
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG) {
        return Err("This handwriting is too big; start a new page".into());
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    let mut text = lines.join("\n");
    text.push('\n');
    file.write_all(text.as_bytes()).map_err(|e| format!("Couldn't save the strokes: {e}"))
}

/// Rewrites this device's own log (after compaction: erased strokes dropped). Other devices' logs
/// are never touched.
pub fn replace_own(dir: &Path, device: &str, lines: &[String]) -> Result<(), String> {
    if lines.iter().any(|l| l.len() > MAX_LINE || l.contains('\n')) {
        return Err("Not ink strokes".into());
    }
    let mut text = lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    write_atomic(&dir.join(format!("strokes-{}.jsonl", device_name(device))), text.as_bytes())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Ink {
    pub doc: Option<String>,
    /// Every device's lines, by device, in file order.
    pub logs: Vec<(String, Vec<String>)>,
    pub backgrounds: Vec<u32>,
}

pub fn load(dir: &Path) -> Ink {
    let mut logs: Vec<(String, Vec<String>)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let device = name.strip_prefix("strokes-")?.strip_suffix(".jsonl")?.to_string();
            let text = fs::read_to_string(e.path()).ok()?;
            Some((device, text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect()))
        })
        .collect();
    logs.sort();
    let mut backgrounds: Vec<u32> = fs::read_dir(dir.join("bg")).into_iter().flatten().flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".png")?.parse().ok()).collect();
    backgrounds.sort();
    Ink { doc: fs::read_to_string(dir.join("doc.json")).ok(), logs, backgrounds }
}

pub fn set_background(dir: &Path, page: u32, png: &[u8]) -> Result<(), String> {
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") || png.len() > MAX_BACKGROUND || page > 2000 {
        return Err("Not a page picture".into());
    }
    let bg = dir.join("bg");
    fs::create_dir_all(&bg).map_err(|e| e.to_string())?;
    write_atomic(&bg.join(format!("{page}.png")), png)
}

fn device(manager: &BridgeLinkManager) -> Result<String, String> {
    let id = manager.instance_id();
    if id.is_empty() { Err("BridgeLink hasn't started yet".into()) } else { Ok(id) }
}

#[tauri::command]
pub fn ink_load(app: AppHandle, id: String) -> Result<Ink, String> {
    Ok(load(&folder(&app, &id)?))
}

#[tauri::command]
pub fn ink_set_doc(app: AppHandle, id: String, doc: String) -> Result<(), String> {
    set_doc(&folder(&app, &id)?, &doc)
}

#[tauri::command]
pub fn ink_append(app: AppHandle, manager: State<'_, BridgeLinkManager>, id: String, lines: Vec<String>) -> Result<(), String> {
    append(&folder(&app, &id)?, &device(&manager)?, &lines)
}

#[tauri::command]
pub fn ink_compact(app: AppHandle, manager: State<'_, BridgeLinkManager>, id: String, lines: Vec<String>) -> Result<(), String> {
    replace_own(&folder(&app, &id)?, &device(&manager)?, &lines)
}

/// A page background as the request body; the ink id and page in `x-id` and `x-page`.
#[tauri::command]
pub fn ink_set_background(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).map(str::to_string).ok_or_else(|| format!("Missing {key}"));
    let (id, page) = (header("x-id")?, header("x-page")?.parse::<u32>().map_err(|_| "Bad page")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Send the picture as bytes".into()) };
    set_background(&folder(&app, &id)?, page, bytes)
}

/// A page background, as a data URL for the editor.
#[tauri::command]
pub fn ink_background(app: AppHandle, id: String, page: u32) -> Result<Option<String>, String> {
    use base64::Engine;
    let path = folder(&app, &id)?.join("bg").join(format!("{page}.png"));
    Ok(fs::read(path).ok().map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_device_appends_to_its_own_log_and_readers_get_all() {
        let shared = std::env::temp_dir().join(format!("bd-ink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&shared);
        let dir = folder_in(&shared, "n1").unwrap();
        assert!(folder_in(&shared, "../x").is_err());
        set_doc(&dir, r#"{"v":1,"paper":"lines"}"#).unwrap();
        assert!(set_doc(&dir, "[]").is_err());
        append(&dir, "mac-1", &[r#"{"id":"a"}"#.into(), r#"{"id":"b"}"#.into()]).unwrap();
        append(&dir, "phone/x", &[r#"{"id":"c"}"#.into()]).unwrap();
        append(&dir, "mac-1", &[r#"{"id":"d"}"#.into()]).unwrap();
        assert!(append(&dir, "mac-1", &["{\"x\":1}\n{\"y\":2}".into()]).is_err());
        // A half-synced line is kept for the reader to skip.
        fs::OpenOptions::new().append(true).open(dir.join("strokes-phone_x.jsonl")).unwrap().write_all(b"{\"id\":\"e").unwrap();
        let ink = load(&dir);
        assert_eq!(ink.doc.as_deref(), Some(r#"{"v":1,"paper":"lines"}"#));
        assert_eq!(ink.logs, vec![("mac-1".into(), vec![r#"{"id":"a"}"#.into(), r#"{"id":"b"}"#.into(), r#"{"id":"d"}"#.into()]), ("phone_x".into(), vec![r#"{"id":"c"}"#.into(), r#"{"id":"e"#.into()])]);
        replace_own(&dir, "mac-1", &[r#"{"id":"d"}"#.into()]).unwrap();
        assert_eq!(load(&dir).logs[0].1, vec![r#"{"id":"d"}"#.to_string()]);
        set_background(&dir, 3, b"\x89PNG\r\n\x1a\nxx").unwrap();
        assert!(set_background(&dir, 4, b"GIF89a").is_err());
        assert_eq!(load(&dir).backgrounds, vec![3]);
        let _ = fs::remove_dir_all(&shared);
    }
}
