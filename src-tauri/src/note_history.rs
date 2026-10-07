//! Earlier versions of notes, kept on this computer (`<app data>/note-history/<note id>/<ms>.json`):
//! before a note is changed, the version it's leaving is kept if the last one kept is ten minutes
//! old or more, so an afternoon's typing leaves a version every ten minutes, not every keystroke.
//! Each note keeps its newest 100. A version can be looked at and put back.

use crate::bridgelink::notes::{to_markdown, Note};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const EVERY_MS: u64 = 10 * 60 * 1000;
const KEEP: usize = 100;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Version {
    pub at: u64,
    pub title: String,
    pub markdown: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub at: u64,
    pub title: String,
    pub preview: String,
    pub chars: usize,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Not a note".into());
    }
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("note-history").join(id))
}

/// The times of a folder's versions, newest first.
fn times(dir: &PathBuf) -> Vec<u64> {
    let mut out: Vec<u64> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".json").and_then(|s| s.parse().ok()))
        .collect();
    out.sort_unstable_by(|a, b| b.cmp(a));
    out
}

fn read(dir: &PathBuf, at: u64) -> Option<Version> {
    serde_json::from_slice(&fs::read(dir.join(format!("{at}.json"))).ok()?).ok()
}

/// Keeps `note` as a version unless one was kept less than ten minutes ago (`force` keeps it
/// anyway, e.g. before putting an older version back) or it's the same as the newest.
pub fn keep_in(dir: &PathBuf, note: &Note, now: u64, force: bool) -> std::io::Result<bool> {
    let newest = times(dir).first().copied();
    if !force && newest.is_some_and(|t| now.saturating_sub(t) < EVERY_MS) {
        return Ok(false);
    }
    let version = Version { at: now, title: note.title.clone(), markdown: to_markdown(note) };
    if version.markdown.trim().is_empty() && version.title.trim().is_empty() {
        return Ok(false);
    }
    if let Some(last) = newest.and_then(|t| read(dir, t)) {
        if last.title == version.title && last.markdown == version.markdown {
            return Ok(false);
        }
    }
    fs::create_dir_all(dir)?;
    fs::write(dir.join(format!("{now}.json")), serde_json::to_vec(&version)?)?;
    for old in times(dir).into_iter().skip(KEEP) {
        let _ = fs::remove_file(dir.join(format!("{old}.json")));
    }
    Ok(true)
}

/// Called before a note changes, with the note as it was.
pub fn before_change(app: &AppHandle, note: &Note, now: u64) {
    if let Ok(dir) = dir(app, &note.id) {
        let _ = keep_in(&dir, note, now, false);
    }
}

pub fn force_keep(app: &AppHandle, note: &Note, now: u64) {
    if let Ok(dir) = dir(app, &note.id) {
        let _ = keep_in(&dir, note, now, true);
    }
}

pub fn version(app: &AppHandle, id: &str, at: u64) -> Result<Version, String> {
    read(&dir(app, id)?, at).ok_or_else(|| "That version isn't there any more".into())
}

#[tauri::command]
pub fn note_versions(app: AppHandle, id: String) -> Result<Vec<VersionInfo>, String> {
    let dir = dir(&app, &id)?;
    Ok(times(&dir)
        .into_iter()
        .filter_map(|at| read(&dir, at))
        .map(|v| VersionInfo { at: v.at, title: v.title, preview: v.markdown.chars().take(160).collect(), chars: v.markdown.chars().count() })
        .collect())
}

#[tauri::command]
pub fn note_version(app: AppHandle, id: String, at: u64) -> Result<Version, String> {
    version(&app, &id, at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridgelink::notes::NoteStore;

    #[test]
    fn keeps_a_version_every_ten_minutes_and_skips_repeats() {
        let dir = std::env::temp_dir().join(format!("bd-history-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut store = NoteStore::default();
        let note = store.create_from_markdown(None, "note", "Lab", "", "First line", "mac", 100).unwrap();
        let min = 60_000;
        assert!(keep_in(&dir, &note, 1_000_000, false).unwrap());
        // Five minutes later: too soon. The same text later: not again.
        assert!(!keep_in(&dir, &note, 1_000_000 + 5 * min, false).unwrap());
        assert!(!keep_in(&dir, &note, 1_000_000 + 11 * min, false).unwrap());
        let changed = store.create_from_markdown(None, "note", "Lab", "", "Second line", "mac", 100).unwrap();
        let changed = Note { id: note.id.clone(), ..changed };
        assert!(keep_in(&dir, &changed, 1_000_000 + 12 * min, false).unwrap());
        assert!(keep_in(&dir, &note, 1_000_000 + 13 * min, true).unwrap());
        let all = times(&dir);
        assert_eq!(all.len(), 3);
        assert_eq!(read(&dir, all[1]).unwrap().markdown, "Second line");
        let _ = fs::remove_dir_all(&dir);
    }
}
