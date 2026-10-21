//! Study state that both computers change: each computer writes only its own file, and reading
//! merges them, so Syncthing never has two versions of one file to choose between.
//!
//! `Study/.state/<key>/<instance id>.json` holds `{v, by, entries: {id: {at, val} | {at, del}}}`.
//! For each entry id the newest `at` wins across the computers' files (a tie goes to the larger
//! computer id, so both computers pick the same one); `del` marks a removal so it spreads. A
//! computer's clock running behind can't lose an edit: a change is stamped after the newest time
//! already seen for that entry.
//!
//! Format v1 (see docs/plans/study-roadmap.md). A reader skips files with a newer `v` and entries
//! it can't read, and never rewrites another computer's file.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::bridgelink::BridgeLinkManager;

const VERSION: u32 = 1;
const DIR: &str = ".state";
/// The kinds of state kept this way; each is added by the change that first uses it.
const KEYS: &[&str] = &["term", "problems"];
const MAX_FILE: u64 = 4 * 1024 * 1024;
const MAX_VALUE: usize = 64 * 1024;
const MAX_ENTRIES: usize = 20_000;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub at: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub del: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub val: Value,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StateFile {
    pub v: u32,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn check_key(key: &str) -> Result<(), String> {
    if KEYS.contains(&key) { Ok(()) } else { Err("Unknown study state".into()) }
}

/// A computer id as a file name (ids are uuids; anything else is made safe).
fn device_file(device: &str) -> String {
    let clean: String = device.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    format!("{}.json", if clean.is_empty() { "device" } else { &clean })
}

/// Every computer's file for `key` under `study`, as (computer, file). Files from a newer format
/// and files that can't be read are left out.
fn read_all(study: &Path, key: &str) -> Vec<(String, StateFile)> {
    let dir = study.join(DIR).join(key);
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") || entry.metadata().map_or(u64::MAX, |m| m.len()) > MAX_FILE {
            continue;
        }
        let Ok(file) = fs::read_to_string(&path).map_err(|_| ()).and_then(|t| serde_json::from_str::<StateFile>(&t).map_err(|_| ())) else { continue };
        if file.v > VERSION {
            continue;
        }
        // A Syncthing conflict copy of a computer's file is still that computer's.
        let by = if file.by.is_empty() { path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default() } else { file.by.clone() };
        out.push((by, file));
    }
    out
}

/// The winning entry for each id across the computers' files: newest `at`, ties to the larger
/// computer id.
pub fn merge(files: &[(String, StateFile)]) -> BTreeMap<String, (u64, String, Entry)> {
    let mut best: BTreeMap<String, (u64, String, Entry)> = BTreeMap::new();
    for (by, file) in files {
        for (id, entry) in &file.entries {
            let newer = best.get(id).is_none_or(|(at, who, _)| (entry.at, by.as_str()) > (*at, who.as_str()));
            if newer {
                best.insert(id.clone(), (entry.at, by.clone(), entry.clone()));
            }
        }
    }
    best
}

/// The current values: removed entries left out.
pub fn values(files: &[(String, StateFile)]) -> BTreeMap<String, Value> {
    merge(files).into_iter().filter(|(_, (_, _, e))| !e.del).map(|(id, (_, _, e))| (id, e.val)).collect()
}

/// Applies `changes` (a value, or null to remove) to this computer's file under `study`. Each
/// change is stamped after the newest time any computer has for that entry.
pub fn put(study: &Path, key: &str, device: &str, changes: BTreeMap<String, Value>, now: u64) -> Result<(), String> {
    check_key(key)?;
    let all = read_all(study, key);
    let seen = merge(&all);
    let dir = study.join(DIR).join(key);
    let path = dir.join(device_file(device));
    let mut mine: StateFile = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).filter(|f: &StateFile| f.v <= VERSION).unwrap_or_default();
    mine.v = VERSION;
    mine.by = device.to_string();
    for (id, val) in changes {
        if id.is_empty() || id.len() > 200 {
            return Err("Not a study state entry".into());
        }
        if serde_json::to_string(&val).is_ok_and(|t| t.len() > MAX_VALUE) {
            return Err("That's too much to keep for one entry".into());
        }
        let at = seen.get(&id).map_or(now, |(at, _, _)| now.max(at + 1));
        let entry = if val.is_null() { Entry { at, del: true, val: Value::Null } } else { Entry { at, del: false, val } };
        mine.entries.insert(id, entry);
    }
    if mine.entries.len() > MAX_ENTRIES {
        return Err("There's too much study state; clear some first".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    let text = serde_json::to_string(&mine).map_err(|e| e.to_string())?;
    let partial = path.with_extension("json.partial");
    fs::write(&partial, text).and_then(|_| fs::rename(&partial, &path)).map_err(|e| format!("Couldn't save study state: {e}"))
}

fn study_root() -> Result<PathBuf, String> {
    crate::study::current_root()
}

/// The merged state for `key`: entry id to value.
#[tauri::command]
pub fn study_state_get(key: String) -> Result<BTreeMap<String, Value>, String> {
    check_key(&key)?;
    Ok(values(&read_all(&study_root()?, &key)))
}

/// Saves changes to `key` (entry id to value; null removes it) as this computer's.
#[tauri::command]
pub fn study_state_put(manager: State<'_, BridgeLinkManager>, key: String, changes: BTreeMap<String, Value>) -> Result<(), String> {
    let device = manager.instance_id();
    if device.is_empty() {
        return Err("BridgeLink hasn't started yet".into());
    }
    put(&study_root()?, &key, &device, changes, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bd-state-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn changes(pairs: &[(&str, Value)]) -> BTreeMap<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn two_computers_edit_offline_and_both_edits_survive() {
        let study = dir("offline");
        // The PC ticks two problems; the Mac, offline, ticks another and unticks one.
        put(&study, "problems", "pc", changes(&[("hw4/1", json!(true)), ("hw4/2", json!(true))]), 1_000).unwrap();
        put(&study, "problems", "mac", changes(&[("hw4/3", json!(true))]), 1_500).unwrap();
        put(&study, "problems", "mac", changes(&[("hw4/1", Value::Null)]), 2_000).unwrap();
        let v = values(&read_all(&study, "problems"));
        assert_eq!(v, changes(&[("hw4/2", json!(true)), ("hw4/3", json!(true))]));
        // Each computer wrote only its own file.
        let mut files: Vec<String> = fs::read_dir(study.join(".state/problems")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        files.sort();
        assert_eq!(files, ["mac.json", "pc.json"]);
        let _ = fs::remove_dir_all(&study);
    }

    #[test]
    fn a_clock_running_behind_still_wins_with_a_later_edit() {
        let study = dir("clock");
        put(&study, "term", "pc", changes(&[("dates", json!({"start": 1}))]), 5_000).unwrap();
        // The Mac's clock is behind, but it changes the dates after seeing the PC's.
        put(&study, "term", "mac", changes(&[("dates", json!({"start": 2}))]), 3_000).unwrap();
        assert_eq!(values(&read_all(&study, "term"))["dates"], json!({"start": 2}));
        let _ = fs::remove_dir_all(&study);
    }

    #[test]
    fn ties_go_the_same_way_on_both_computers() {
        let file = |by: &str, val: Value| (by.to_string(), StateFile { v: 1, by: by.into(), entries: [("x".to_string(), Entry { at: 7, del: false, val })].into() });
        let a = values(&[file("aaa", json!(1)), file("zzz", json!(2))]);
        let b = values(&[file("zzz", json!(2)), file("aaa", json!(1))]);
        assert_eq!(a, b);
        assert_eq!(a["x"], json!(2));
    }

    #[test]
    fn unknown_keys_newer_formats_and_bad_files_are_left_alone() {
        let study = dir("bad");
        assert!(put(&study, "../x", "pc", changes(&[("a", json!(1))]), 1).is_err());
        assert!(put(&study, "secrets", "pc", changes(&[("a", json!(1))]), 1).is_err());
        assert!(put(&study, "term", "pc", changes(&[("", json!(1))]), 1).is_err());
        let big = json!("x".repeat(MAX_VALUE + 10));
        assert!(put(&study, "term", "pc", changes(&[("a", big)]), 1).is_err());
        put(&study, "term", "pc", changes(&[("a", json!(1))]), 1).unwrap();
        let d = study.join(".state/term");
        fs::write(d.join("future.json"), r#"{"v":2,"by":"future","entries":{"a":{"at":99,"val":5}}}"#).unwrap();
        fs::write(d.join("broken.json"), "{not json").unwrap();
        fs::write(d.join("pc.sync-conflict-20261021-101500-ABCDEF7.json"), r#"{"v":1,"by":"pc","entries":{"b":{"at":3,"val":2}}}"#).unwrap();
        let v = values(&read_all(&study, "term"));
        assert_eq!(v, changes(&[("a", json!(1)), ("b", json!(2))]));
        // A device id is made safe as a file name.
        put(&study, "term", "../../evil", changes(&[("c", json!(1))]), 2).unwrap();
        assert!(d.join("evil.json").exists() && !study.parent().unwrap().join("evil.json").exists());
        let _ = fs::remove_dir_all(&study);
    }
}
