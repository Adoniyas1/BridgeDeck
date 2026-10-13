//! Logic circuits from the Logic tab, kept as files in the shared folder so they're on both
//! computers: `<shared>/Projects/<project>/Circuits/<name>.circuit.json` for a project's, else
//! `<shared>/Circuits/<name>.circuit.json`. The circuit itself is the Logic tab's JSON.

use serde::Serialize;
use std::{fs, path::PathBuf, time::UNIX_EPOCH};
use tauri::AppHandle;

const EXT: &str = ".circuit.json";
const MAX_BYTES: usize = 5 * 1024 * 1024;
/// Earlier versions: each save keeps the one it replaces in `Circuits/.history/<name>/<ms>.circuit.json`.
const HISTORY: &str = ".history";
const KEEP_VERSIONS: usize = 40;

pub(crate) fn shared(app: &AppHandle) -> PathBuf {
    let shared = crate::shared_folder(app);
    if shared.trim().is_empty() { crate::study::default_shared() } else { PathBuf::from(shared.trim()) }
}

/// A name usable as a file name: no folders, nothing hidden, not too long.
pub fn valid_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && name.len() <= 80 && !name.starts_with('.') && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0']) && name != ".."
}

fn folder(app: &AppHandle, project: &str) -> Result<PathBuf, String> {
    if project.is_empty() {
        return Ok(shared(app).join("Circuits"));
    }
    if !valid_name(project) {
        return Err("Not a project".into());
    }
    let dir = crate::projects::root_for(&crate::shared_folder(app)).join(project);
    if !dir.is_dir() {
        return Err(format!("There's no project called {project}"));
    }
    Ok(dir.join("Circuits"))
}

fn file(app: &AppHandle, project: &str, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("That name can't be used for a file (no / \\ : * ? \" < > |)".into());
    }
    Ok(folder(app, project)?.join(format!("{}{EXT}", name.trim())))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitFile {
    /// The project it belongs to ("" for none).
    pub project: String,
    pub name: String,
    pub modified: u64,
}

fn files_in(dir: &PathBuf, project: &str, out: &mut Vec<CircuitFile>) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let Some(name) = file_name.strip_suffix(EXT) else { continue };
        let modified = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        out.push(CircuitFile { project: project.to_string(), name: name.to_string(), modified });
    }
}

#[tauri::command]
pub fn circuits_list(app: AppHandle) -> Vec<CircuitFile> {
    let mut out = Vec::new();
    files_in(&shared(&app).join("Circuits"), "", &mut out);
    let root = crate::projects::root_for(&crate::shared_folder(&app));
    for project in fs::read_dir(&root).into_iter().flatten().flatten().filter(|e| e.path().is_dir()) {
        let name = project.file_name().to_string_lossy().to_string();
        if !name.starts_with('.') {
            files_in(&project.path().join("Circuits"), &name, &mut out);
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

#[tauri::command]
pub fn circuit_load(app: AppHandle, project: String, name: String) -> Result<String, String> {
    fs::read_to_string(file(&app, &project, &name)?).map_err(|e| format!("Couldn't open {name}: {e}"))
}

#[tauri::command]
pub fn circuit_save(app: AppHandle, project: String, name: String, circuit: String) -> Result<(), String> {
    if circuit.len() > MAX_BYTES {
        return Err("That circuit is too big to save".into());
    }
    serde_json::from_str::<serde_json::Value>(&circuit).map_err(|_| "Not a circuit".to_string())?;
    let path = file(&app, &project, &name)?;
    fs::create_dir_all(path.parent().ok_or("No folder")?).map_err(|e| e.to_string())?;
    keep_version(&path, &history_dir(&app, &project, &name)?, &circuit, now_ms());
    let partial = path.with_extension("partial");
    fs::write(&partial, circuit).and_then(|_| fs::rename(&partial, &path)).map_err(|e| format!("Couldn't save {name}: {e}"))
}

#[tauri::command]
pub fn circuit_delete(app: AppHandle, project: String, name: String) -> Result<(), String> {
    let path = file(&app, &project, &name)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_dir_all(history_dir(&app, &project, &name)?);
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn history_dir(app: &AppHandle, project: &str, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("Not a circuit".into());
    }
    Ok(folder(app, project)?.join(HISTORY).join(name.trim()))
}

fn versions_in(dir: &PathBuf) -> Vec<u64> {
    let mut out: Vec<u64> = fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(EXT).and_then(|s| s.parse().ok())).collect();
    out.sort_unstable_by(|a, b| b.cmp(a));
    out
}

/// Before `path` is replaced by `next`, its current content is kept as a version (unless it's the same).
fn keep_version(path: &PathBuf, dir: &PathBuf, next: &str, now: u64) {
    let Ok(current) = fs::read_to_string(path) else { return };
    if current == next || fs::create_dir_all(dir).is_err() {
        return;
    }
    let _ = fs::write(dir.join(format!("{now}{EXT}")), current);
    for old in versions_in(dir).into_iter().skip(KEEP_VERSIONS) {
        let _ = fs::remove_file(dir.join(format!("{old}{EXT}")));
    }
}

/// When each earlier version of a circuit was replaced, newest first.
#[tauri::command]
pub fn circuit_versions(app: AppHandle, project: String, name: String) -> Result<Vec<u64>, String> {
    Ok(versions_in(&history_dir(&app, &project, &name)?))
}

#[tauri::command]
pub fn circuit_version_load(app: AppHandle, project: String, name: String, at: u64) -> Result<String, String> {
    fs::read_to_string(history_dir(&app, &project, &name)?.join(format!("{at}{EXT}"))).map_err(|_| "That version isn't there any more".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_keep_the_version_they_replace() {
        let dir = std::env::temp_dir().join(format!("bd-circuit-versions-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Adder.circuit.json");
        let history = dir.join(HISTORY).join("Adder");
        keep_version(&path, &history, "{}", 1); // nothing saved yet
        fs::write(&path, "{\"v\":1}").unwrap();
        keep_version(&path, &history, "{\"v\":1}", 2); // unchanged
        keep_version(&path, &history, "{\"v\":2}", 3);
        assert_eq!(versions_in(&history), vec![3]);
        assert_eq!(fs::read_to_string(history.join("3.circuit.json")).unwrap(), "{\"v\":1}");
        for t in 10..60 {
            keep_version(&path, &history, &format!("{{\"t\":{t}}}"), t);
        }
        assert_eq!(versions_in(&history).len(), KEEP_VERSIONS);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_are_plain_file_names() {
        assert!(valid_name("Half adder") && valid_name("Lab 3 – 2-bit comparator"));
        assert!(!valid_name("../x") && !valid_name("a/b") && !valid_name(".hidden") && !valid_name("") && !valid_name("a:b"));
        assert!(!valid_name(&"x".repeat(81)));
    }
}
