//! Logic circuits from the Logic tab, kept as files in the shared folder so they're on both
//! computers: `<shared>/Projects/<project>/Circuits/<name>.circuit.json` for a project's, else
//! `<shared>/Circuits/<name>.circuit.json`. The circuit itself is the Logic tab's JSON.

use serde::Serialize;
use std::{fs, path::PathBuf, time::UNIX_EPOCH};
use tauri::AppHandle;

const EXT: &str = ".circuit.json";
const MAX_BYTES: usize = 5 * 1024 * 1024;

fn shared(app: &AppHandle) -> PathBuf {
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
    let partial = path.with_extension("partial");
    fs::write(&partial, circuit).and_then(|_| fs::rename(&partial, &path)).map_err(|e| format!("Couldn't save {name}: {e}"))
}

#[tauri::command]
pub fn circuit_delete(app: AppHandle, project: String, name: String) -> Result<(), String> {
    let path = file(&app, &project, &name)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_file_names() {
        assert!(valid_name("Half adder") && valid_name("Lab 3 – 2-bit comparator"));
        assert!(!valid_name("../x") && !valid_name("a/b") && !valid_name(".hidden") && !valid_name("") && !valid_name("a:b"));
        assert!(!valid_name(&"x".repeat(81)));
    }
}
