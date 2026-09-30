//! Syncthing conflict copies (`report.sync-conflict-20260930-101500-ABCDEF7.docx`): finding them in a
//! shared folder and resolving them. Nothing is deleted outright; the version not kept goes to the
//! system Trash / Recycle Bin.

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MARKER: &str = ".sync-conflict-";
const MAX_RESULTS: usize = 500;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub conflict_path: String,
    pub original_path: String,
    pub original_exists: bool,
    pub conflict_size: u64,
    pub original_size: u64,
    /// Milliseconds since the epoch.
    pub conflict_modified: u64,
    pub original_modified: u64,
}

/// The file a conflict copy belongs to: the name with its `.sync-conflict-<date>-<time>-<device>` part removed.
pub fn original_name(conflict: &str) -> Option<String> {
    let start = conflict.find(MARKER)?;
    let rest = &conflict[start + MARKER.len()..];
    let end = rest.find('.').map(|i| start + MARKER.len() + i).unwrap_or(conflict.len());
    let original = format!("{}{}", &conflict[..start], &conflict[end..]);
    (!original.is_empty()).then_some(original)
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn find(root: &Path) -> Vec<SyncConflict> {
    let mut found = Vec::new();
    let walker = walkdir::WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !(e.depth() > 0 && (name == ".stfolder" || name == ".stversions" || name == ".git"))
    });
    for entry in walker.filter_map(Result::ok) {
        if found.len() >= MAX_RESULTS {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(original) = original_name(&name) else { continue };
        let original_path = entry.path().with_file_name(original);
        let conflict_meta = entry.metadata().ok();
        let original_meta = fs::metadata(&original_path).ok();
        found.push(SyncConflict {
            conflict_path: entry.path().to_string_lossy().to_string(),
            original_path: original_path.to_string_lossy().to_string(),
            original_exists: original_meta.is_some(),
            conflict_size: conflict_meta.as_ref().map(|m| m.len()).unwrap_or(0),
            original_size: original_meta.as_ref().map(|m| m.len()).unwrap_or(0),
            conflict_modified: conflict_meta.as_ref().map(modified_ms).unwrap_or(0),
            original_modified: original_meta.as_ref().map(modified_ms).unwrap_or(0),
        });
    }
    found.sort_by(|a, b| b.conflict_modified.cmp(&a.conflict_modified));
    found
}

/// Checks `conflict` is a conflict copy inside `root` and returns it with its original's path.
fn checked(root: &Path, conflict: &Path) -> Result<(PathBuf, PathBuf), String> {
    let root = root.canonicalize().map_err(|_| "The shared folder doesn't exist".to_string())?;
    let conflict = conflict.canonicalize().map_err(|_| "That conflict copy no longer exists".to_string())?;
    if !conflict.starts_with(&root) || !conflict.is_file() {
        return Err("That file isn't in this shared folder".into());
    }
    let name = conflict.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let original = original_name(&name).ok_or("That file isn't a conflict copy")?;
    Ok((conflict.with_file_name(original), conflict))
}

/// `keep`: "current" keeps the file as it is and trashes the conflict copy; "conflict" puts the conflict
/// copy in its place and trashes the current file.
pub fn resolve(root: &Path, conflict: &Path, keep: &str) -> Result<(), String> {
    let (original, conflict) = checked(root, conflict)?;
    match keep {
        "current" => trash::delete(&conflict).map_err(|e| format!("Could not move the conflict copy to the Trash: {e}")),
        "conflict" => {
            if original.exists() {
                trash::delete(&original).map_err(|e| format!("Could not move the current file to the Trash: {e}"))?;
            }
            fs::rename(&conflict, &original).map_err(|e| format!("Could not put the conflict copy in place: {e}"))
        }
        _ => Err("Choose which version to keep".into()),
    }
}

#[tauri::command]
pub async fn sync_conflicts(folder_path: String) -> Result<Vec<SyncConflict>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(folder_path);
        if !root.is_dir() {
            return Err("The shared folder doesn't exist on this computer".to_string());
        }
        Ok(find(&root))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sync_resolve_conflict(folder_path: String, conflict_path: String, keep: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || resolve(Path::new(&folder_path), Path::new(&conflict_path), &keep))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_names() {
        assert_eq!(original_name("report.sync-conflict-20260930-101500-ABCDEF7.docx").as_deref(), Some("report.docx"));
        assert_eq!(original_name("notes.sync-conflict-20260930-101500-ABCDEF7").as_deref(), Some("notes"));
        assert_eq!(original_name("archive.tar.sync-conflict-20260930-101500-ABCDEF7.gz").as_deref(), Some("archive.tar.gz"));
        assert_eq!(original_name("report.docx"), None);
    }

    #[test]
    fn finds_conflicts_and_keeps_the_current_version() {
        let root = std::env::temp_dir().join(format!("bd-conflicts-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("sub/.stversions")).unwrap();
        fs::write(root.join("sub/a.txt"), "current").unwrap();
        fs::write(root.join("sub/a.sync-conflict-20260930-101500-ABCDEF7.txt"), "theirs").unwrap();
        fs::write(root.join("sub/.stversions/b.sync-conflict-20260930-101500-ABCDEF7.txt"), "ignored").unwrap();
        let found = find(&root);
        assert_eq!(found.len(), 1);
        assert!(found[0].original_exists);
        assert!(found[0].original_path.ends_with("a.txt"));

        // Replacing with the conflict copy is exercised without the Trash: rename only when no original.
        fs::remove_file(root.join("sub/a.txt")).unwrap();
        resolve(&root, Path::new(&found[0].conflict_path), "conflict").unwrap();
        assert_eq!(fs::read_to_string(root.join("sub/a.txt")).unwrap(), "theirs");
        assert!(find(&root).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_files_outside_the_folder_or_not_conflicts() {
        let root = std::env::temp_dir().join(format!("bd-conflicts-{}", uuid::Uuid::new_v4()));
        let other = std::env::temp_dir().join(format!("bd-other-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(root.join("plain.txt"), "x").unwrap();
        fs::write(other.join("x.sync-conflict-20260930-101500-ABCDEF7.txt"), "x").unwrap();
        assert!(resolve(&root, &root.join("plain.txt"), "current").is_err());
        assert!(resolve(&root, &other.join("x.sync-conflict-20260930-101500-ABCDEF7.txt"), "current").is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(other);
    }
}
