//! Projects: one folder per project inside the folder the paired computers sync
//! (`BridgeDeck Shared/Projects/<Project>/`), so its files are on both computers. A project's
//! notes, task board and milestones are ordinary notes (folder `Projects/<Project>`) and calendar
//! events. Mimir's own Projects folder is this one too (`MIMIR_PROJECTS_ROOT`), so its project
//! tools read and write the same files.

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

use crate::study::clean_name;

/// The projects folder, remembered from the Projects tab.
static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
const IGNORED: &[&str] = &["node_modules", ".git", ".stfolder", ".stversions", "__pycache__", "target", ".venv"];
const MAX_FILES: usize = 400;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub files: usize,
    pub bytes: u64,
    /// Newest change to any file (ms).
    pub modified: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectList {
    pub root: String,
    pub projects: Vec<Project>,
    /// Projects in Mimir's old folder (Documents/Mimir Projects) not here yet.
    pub mimir_old: Vec<String>,
    pub mimir_old_path: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    /// Path inside the project, with `/`.
    pub path: String,
    pub bytes: u64,
    pub modified: u64,
}

/// `<shared folder>/Projects`.
pub fn root_for(shared: &str) -> PathBuf {
    let shared = if shared.trim().is_empty() { crate::study::default_shared() } else { PathBuf::from(shared.trim()) };
    shared.join("Projects")
}

pub fn root_or_default() -> PathBuf {
    ROOT.lock().ok().and_then(|r| r.clone()).unwrap_or_else(|| root_for(""))
}

fn mimir_old_root() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join("Documents").join("Mimir Projects")
}

fn millis(time: std::io::Result<std::time::SystemTime>) -> u64 {
    time.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn skip(name: &str) -> bool {
    name.starts_with('.') || IGNORED.contains(&name) || name.contains(".sync-conflict-")
}

/// Every file of a project, newest first (up to `MAX_FILES`).
pub fn files(dir: &Path) -> Vec<ProjectFile> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0usize;
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else { continue };
            if skip(&name) || kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                seen += 1;
                if seen > 20_000 {
                    break;
                }
                let meta = entry.metadata().ok();
                let rel = entry.path().strip_prefix(dir).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or(name);
                out.push(ProjectFile { path: rel, bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0), modified: millis(meta.map(|m| m.modified()).unwrap_or_else(|| Err(std::io::ErrorKind::NotFound.into()))) });
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.path.cmp(&b.path)));
    out
}

fn folders(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root)
        .map(|d| d.filter_map(Result::ok).filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| !skip(n)).collect())
        .unwrap_or_default();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

pub fn list(root: &Path, mimir_old: &Path) -> Result<ProjectList, String> {
    fs::create_dir_all(root).map_err(|e| format!("Can't use the Projects folder {}: {e}", root.display()))?;
    let projects: Vec<Project> = folders(root)
        .into_iter()
        .map(|name| {
            let all = files(&root.join(&name));
            Project { files: all.len(), bytes: all.iter().map(|f| f.bytes).sum(), modified: all.iter().map(|f| f.modified).max().unwrap_or(0), name }
        })
        .collect();
    let here: Vec<String> = projects.iter().map(|p| p.name.to_lowercase()).collect();
    let old = if mimir_old != root { folders(mimir_old).into_iter().filter(|n| !here.contains(&n.to_lowercase())).collect() } else { Vec::new() };
    Ok(ProjectList { root: root.to_string_lossy().to_string(), projects, mimir_old: old, mimir_old_path: mimir_old.to_string_lossy().to_string() })
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.filter_map(Result::ok) {
        let kind = entry.file_type()?;
        let name = entry.file_name();
        if kind.is_symlink() || name.to_string_lossy() == ".git" {
            continue;
        }
        if kind.is_dir() {
            copy_dir(&entry.path(), &to.join(&name))?;
        } else {
            fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

/// Copies Mimir's old projects in (the originals stay where they were). Returns how many.
pub fn import_old(root: &Path, mimir_old: &Path) -> Result<usize, String> {
    let names = list(root, mimir_old)?.mimir_old;
    for name in &names {
        copy_dir(&mimir_old.join(name), &root.join(name)).map_err(|e| format!("Couldn't copy {name}: {e}"))?;
    }
    Ok(names.len())
}

fn current_root() -> Result<PathBuf, String> {
    ROOT.lock().ok().and_then(|r| r.clone()).ok_or_else(|| "Open the Projects tab first".into())
}

/// A project folder by name, only if it is directly inside the projects folder.
fn project_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    let dir = root.join(name);
    if name.contains(['/', '\\']) || name.starts_with('.') || !dir.is_dir() {
        return Err("No such project".into());
    }
    Ok(dir)
}

// ---- Commands ----

#[tauri::command]
pub fn projects_list(shared: String) -> Result<ProjectList, String> {
    let root = root_for(&shared);
    if let Ok(mut stored) = ROOT.lock() {
        *stored = Some(root.clone());
    }
    list(&root, &mimir_old_root())
}

#[tauri::command]
pub fn projects_add(name: String) -> Result<String, String> {
    let name = clean_name(&name)?;
    fs::create_dir_all(current_root()?.join(&name)).map_err(|e| e.to_string())?;
    Ok(name)
}

#[tauri::command]
pub fn projects_files(project: String) -> Result<Vec<ProjectFile>, String> {
    let mut all = files(&project_dir(&current_root()?, &project)?);
    all.truncate(MAX_FILES);
    Ok(all)
}

/// Files BridgeDeck keeps in a project folder: the parts list (a spreadsheet as CSV, so it also
/// opens in Excel or Numbers) and the project's settings (its budget).
const PROJECT_FILES: &[&str] = &["parts.csv", "project.json"];
const MAX_PROJECT_FILE: usize = 1024 * 1024;

#[tauri::command]
pub fn project_file_read(project: String, name: String) -> Result<Option<String>, String> {
    if !PROJECT_FILES.contains(&name.as_str()) {
        return Err("Not a project file".into());
    }
    let path = project_dir(&current_root()?, &project)?.join(&name);
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn project_file_write(project: String, name: String, text: String) -> Result<(), String> {
    if !PROJECT_FILES.contains(&name.as_str()) {
        return Err("Not a project file".into());
    }
    if text.len() > MAX_PROJECT_FILE {
        return Err("That's too big to save".into());
    }
    let path = project_dir(&current_root()?, &project)?.join(&name);
    let partial = path.with_extension("partial");
    fs::write(&partial, text).and_then(|_| fs::rename(&partial, &path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn projects_import_mimir() -> Result<usize, String> {
    import_old(&current_root()?, &mimir_old_root())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_are_folders_with_their_files_and_mimirs_old_ones_can_be_copied_in() {
        let base = std::env::temp_dir().join(format!("bd-projects-{}", uuid::Uuid::new_v4()));
        let root = root_for(&base.to_string_lossy());
        let old = base.join("Mimir Projects");
        fs::create_dir_all(root.join("Robot/cad")).unwrap();
        fs::write(root.join("Robot/notes.md"), "hi").unwrap();
        fs::write(root.join("Robot/cad/chassis.FCStd"), "1234").unwrap();
        fs::create_dir_all(root.join("Robot/node_modules/x")).unwrap();
        fs::write(root.join("Robot/node_modules/x/big.js"), "ignored").unwrap();
        fs::create_dir_all(old.join("Thesis/figures")).unwrap();
        fs::write(old.join("Thesis/figures/plot.png"), "png").unwrap();
        fs::create_dir_all(old.join("robot")).unwrap();

        let listed = list(&root, &old).unwrap();
        assert_eq!(listed.projects.len(), 1);
        assert_eq!((listed.projects[0].files, listed.projects[0].bytes), (2, 6));
        assert_eq!(listed.mimir_old, vec!["Thesis".to_string()], "Robot is already here (names match ignoring case)");
        let mut paths: Vec<String> = files(&root.join("Robot")).into_iter().map(|f| f.path).collect();
        paths.sort();
        assert_eq!(paths, vec!["cad/chassis.FCStd", "notes.md"]);

        assert_eq!(import_old(&root, &old).unwrap(), 1);
        assert!(root.join("Thesis/figures/plot.png").is_file());
        assert!(old.join("Thesis/figures/plot.png").is_file(), "the original stays");
        assert!(list(&root, &old).unwrap().mimir_old.is_empty());
        assert!(project_dir(&root, "../Mimir Projects").is_err());
        let _ = fs::remove_dir_all(base);
    }
}
