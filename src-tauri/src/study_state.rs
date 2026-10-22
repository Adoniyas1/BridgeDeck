//! Study state that both computers change: each computer writes only its own file, and reading
//! merges them, so Syncthing never has two versions of one file to choose between.
//!
//! `Study/.state/<key>/<instance id>.json` holds `{v, by, entries: {id: {at, val} | {at, del}}}`.
//! For each entry id the newest `at` wins across the computers' files (a tie goes to the larger
//! computer id, so both computers pick the same one); `del` marks a removal so it spreads. A
//! computer's clock running behind can't lose an edit: a change is stamped after the newest time
//! already seen for that entry.
//!
//! Older builds kept the term and ticked problems in single files (`.term.json`,
//! `.problems.json`). Those are still read, as one more computer ("legacy") whose changes are as
//! new as the file, and rewritten with the merged result after every change here, so a computer
//! that hasn't been updated yet sees and keeps the same state.
//!
//! Format v1 (see docs/formats.md). A reader skips files with a newer `v` and entries
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
const KEYS: &[&str] = &["term", "problems", "reading", "canvasDone", "exam", "inbox"];
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
    let mut ids: Vec<String> = Vec::new();
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
        ids.extend(file.entries.keys().cloned());
        out.push((by, file));
    }
    if let Some(legacy) = read_legacy(study, key, &ids) {
        out.push((LEGACY.to_string(), legacy));
    }
    out
}

const LEGACY: &str = "legacy";
/// Separates an assignment from a problem in a `problems` entry id ("<assignment>\u{1f}<problem>").
pub const SEP: char = '\u{1f}';

fn legacy_file(key: &str) -> Option<&'static str> {
    match key {
        "term" => Some(".term.json"),
        "problems" => Some(".problems.json"),
        _ => None,
    }
}

/// An older build's single file for `key`, as entries stamped with the file's time. It holds the
/// whole state, so ids it doesn't list (from `known`) are removals as of then.
fn read_legacy(study: &Path, key: &str, known: &[String]) -> Option<StateFile> {
    let path = study.join(legacy_file(key)?);
    let at = fs::metadata(&path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    let raw: Value = serde_json::from_str(&fs::read_to_string(&path).ok()?).ok()?;
    let mut entries = BTreeMap::new();
    match key {
        "term" => {
            let set = raw.as_object().is_some_and(|o| !o.is_empty());
            entries.insert("term".to_string(), if set { Entry { at, del: false, val: raw } } else { Entry { at, del: true, val: Value::Null } });
        }
        "problems" => {
            for (assignment, list) in raw.as_object()? {
                for problem in list.as_array().into_iter().flatten().filter_map(Value::as_str) {
                    entries.insert(format!("{assignment}{SEP}{problem}"), Entry { at, del: false, val: Value::Bool(true) });
                }
            }
        }
        _ => return None,
    }
    // Only ids the old file can hold: the term, and "<assignment><SEP><problem>".
    for id in known.iter().filter(|id| if key == "term" { id.as_str() == "term" } else { id.contains(SEP) }) {
        entries.entry(id.clone()).or_insert(Entry { at, del: true, val: Value::Null });
    }
    Some(StateFile { v: VERSION, by: LEGACY.into(), entries })
}

/// Rewrites the older build's file for `key` with the merged state, dated by the newest change in
/// it (so, read back, it doesn't look newer than the changes it holds).
fn write_legacy(study: &Path, key: &str, files: &[(String, StateFile)]) -> Result<(), String> {
    let merged = values(files);
    let newest = merge(files).values().map(|(at, _, _)| *at).max().unwrap_or(0);
    let Some(name) = legacy_file(key) else { return Ok(()) };
    let value = match key {
        "term" => merged.get("term").cloned().unwrap_or_else(|| serde_json::json!({})),
        _ => {
            let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for id in merged.keys() {
                if let Some((assignment, problem)) = id.split_once(SEP) {
                    out.entry(assignment.to_string()).or_default().push(problem.to_string());
                }
            }
            serde_json::to_value(out).map_err(|e| e.to_string())?
        }
    };
    let path = study.join(name);
    let now: Option<Value> = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok());
    if now.as_ref() == Some(&value) {
        return Ok(());
    }
    let partial = path.with_extension("json.partial");
    fs::write(&partial, value.to_string()).map_err(|e| format!("Couldn't save study state: {e}"))?;
    if newest > 0 {
        let time = UNIX_EPOCH + std::time::Duration::from_millis(newest);
        let _ = fs::File::options().write(true).open(&partial).and_then(|f| f.set_modified(time));
    }
    fs::rename(&partial, &path).map_err(|e| format!("Couldn't save study state: {e}"))
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
    fs::write(&partial, text).and_then(|_| fs::rename(&partial, &path)).map_err(|e| format!("Couldn't save study state: {e}"))?;
    write_legacy(study, key, &read_all(study, key))
}

fn study_root() -> Result<PathBuf, String> {
    crate::study::current_root()
}

/// The merged state for `key` in the current Study folder (for Mimir's routes).
pub fn current_values(key: &str) -> BTreeMap<String, Value> {
    study_root().map(|root| values(&read_all(&root, key))).unwrap_or_default()
}

/// Saves changes to `key` in the current Study folder as `device`'s (for Mimir's routes).
pub fn put_current(key: &str, device: &str, changes: BTreeMap<String, Value>) -> Result<(), String> {
    if device.is_empty() {
        return Err("BridgeLink hasn't started yet".into());
    }
    put(&study_root()?, key, device, changes, now_ms())
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

// ---- Exam mode ----

/// Exam mode, if it's on now on either computer: `{course, until}` (ms).
pub fn exam_now(now: u64) -> Option<Value> {
    let study = study_root().ok()?;
    let exam = values(&read_all(&study, "exam")).remove("exam")?;
    (exam.get("until").and_then(Value::as_u64)? > now).then_some(exam)
}

// ---- What Canvas sent last ----
//
// Each computer that's signed in to Canvas keeps its last good copy in `Study/.canvas/<id>.json`
// (`{at, …}`), so the other computer (signed in or not), the phone and Mimir can all read the newest.

const CANVAS_DIR: &str = ".canvas";
const MAX_CANVAS: usize = 3 * 1024 * 1024;

fn newest_canvas(study: &Path) -> Option<Value> {
    let mut best: Option<(u64, Value)> = None;
    for entry in fs::read_dir(study.join(CANVAS_DIR)).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") || entry.metadata().map_or(u64::MAX, |m| m.len()) > MAX_CANVAS as u64 {
            continue;
        }
        let Some(value) = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let at = value.get("at").and_then(Value::as_u64).unwrap_or(0);
        if best.as_ref().is_none_or(|(b, _)| at > *b) {
            best = Some((at, value));
        }
    }
    best.map(|(_, v)| v)
}

fn put_canvas(study: &Path, device: &str, data: &Value) -> Result<(), String> {
    let text = serde_json::to_string(data).map_err(|e| e.to_string())?;
    if text.len() > MAX_CANVAS || data.get("at").and_then(Value::as_u64).is_none() {
        return Err("That isn't Canvas data BridgeDeck can keep".into());
    }
    let dir = study.join(CANVAS_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(device_file(device));
    let partial = path.with_extension("json.partial");
    fs::write(&partial, text).and_then(|_| fs::rename(&partial, &path)).map_err(|e| format!("Couldn't save the Canvas copy: {e}"))
}

/// The newest copy of what Canvas sent, from either computer (null when there's none).
pub fn canvas_snapshot() -> Option<Value> {
    newest_canvas(&study_root().ok()?)
}

#[tauri::command]
pub fn study_canvas_get() -> Result<Value, String> {
    Ok(newest_canvas(&study_root()?).unwrap_or(Value::Null))
}

/// Keeps this computer's copy of what Canvas sent (`{at, feed, api, courses, announcements}`).
#[tauri::command]
pub fn study_canvas_put(manager: State<'_, BridgeLinkManager>, data: Value) -> Result<(), String> {
    let device = manager.instance_id();
    if device.is_empty() {
        return Err("BridgeLink hasn't started yet".into());
    }
    put_canvas(&study_root()?, &device, &data)
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

    fn set_mtime(path: &Path, ms: u64) {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
        fs::File::options().write(true).open(path).unwrap().set_modified(t).unwrap();
    }

    #[test]
    fn an_older_build_and_a_newer_one_share_the_ticks() {
        let study = dir("legacy");
        fs::create_dir_all(&study).unwrap();
        let id = |a: &str, p: &str| format!("{a}{SEP}{p}");
        // What an older build left: two ticks.
        fs::write(study.join(".problems.json"), r#"{"hw4":["1","2"]}"#).unwrap();
        set_mtime(&study.join(".problems.json"), 1_000);
        assert_eq!(values(&read_all(&study, "problems")).len(), 2);
        // This build unticks 1 and ticks 3; the old file is rewritten to match.
        put(&study, "problems", "pc", changes(&[(id("hw4", "1").as_str(), Value::Null), (id("hw4", "3").as_str(), json!(true))]), 2_000).unwrap();
        let legacy: Value = serde_json::from_str(&fs::read_to_string(study.join(".problems.json")).unwrap()).unwrap();
        assert_eq!(legacy, json!({"hw4": ["2", "3"]}));
        // The other computer, not yet updated, unticks 2 later (rewriting the whole file).
        fs::write(study.join(".problems.json"), r#"{"hw4":["3"]}"#).unwrap();
        set_mtime(&study.join(".problems.json"), 3_000);
        let v = values(&read_all(&study, "problems"));
        assert_eq!(v.keys().cloned().collect::<Vec<_>>(), vec![id("hw4", "3")]);
        // The term: the old file's dates count until this build changes them.
        fs::write(study.join(".term.json"), r#"{"start":"2026-08-24","end":"2026-12-18","breaks":[]}"#).unwrap();
        set_mtime(&study.join(".term.json"), 1_000);
        assert_eq!(values(&read_all(&study, "term"))["term"]["start"], "2026-08-24");
        put(&study, "term", "mac", changes(&[("term", json!({"start":"2027-01-20","end":"2027-05-15","breaks":[]}))]), 5_000).unwrap();
        assert_eq!(values(&read_all(&study, "term"))["term"]["start"], "2027-01-20");
        assert!(fs::read_to_string(study.join(".term.json")).unwrap().contains("2027-01-20"));
        // Clearing the term clears the old file too ("{}", as older builds write).
        put(&study, "term", "mac", changes(&[("term", Value::Null)]), 6_000).unwrap();
        assert!(values(&read_all(&study, "term")).is_empty());
        assert_eq!(fs::read_to_string(study.join(".term.json")).unwrap(), "{}");
        let _ = fs::remove_dir_all(&study);
    }

    #[test]
    fn the_newest_canvas_copy_wins_whichever_computer_made_it() {
        let study = dir("canvas");
        put_canvas(&study, "pc", &json!({"at": 10, "api": [1]})).unwrap();
        put_canvas(&study, "mac", &json!({"at": 20, "api": [2]})).unwrap();
        assert_eq!(newest_canvas(&study).unwrap()["api"], json!([2]));
        put_canvas(&study, "pc", &json!({"at": 30, "api": [3]})).unwrap();
        assert_eq!(newest_canvas(&study).unwrap()["api"], json!([3]));
        assert!(put_canvas(&study, "pc", &json!({"api": []})).is_err());
        let _ = fs::remove_dir_all(&study);
    }
}
