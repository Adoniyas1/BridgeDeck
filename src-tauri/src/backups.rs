//! Daily backups of notes (flashcards are notes), the calendar and settings, to the shared folder,
//! so a copy is on both computers: `<shared>/BridgeDeck Backups/<computer>/<date>.json`, the last
//! two weeks of each computer's. Restoring puts notes and events back as new edits, so the restored
//! versions win on both computers; nothing made since the backup is deleted.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::bridgelink::{calendar, notes, BridgeLinkManager};

const FOLDER: &str = "BridgeDeck Backups";
const KEEP: usize = 14;
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub version: u32,
    pub made: u64,
    pub computer: String,
    pub notes: Vec<notes::Note>,
    pub events: Vec<calendar::Event>,
    /// BridgeDeck's settings as saved (secrets are in the system keychain, not here).
    pub settings: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub computer: String,
    pub date: String,
    pub made: u64,
    pub notes: usize,
    pub events: usize,
    pub bytes: u64,
    /// Made by this computer (its settings can be restored here).
    pub mine: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub notes: usize,
    pub events: usize,
    pub settings: Option<serde_json::Value>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// "2026-10-06" for a time in milliseconds (UTC).
pub fn date_of(ms: u64) -> String {
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// A computer's name as a folder name.
fn folder_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '_' }).collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "BridgeDeck".into() } else { clean.chars().take(60).collect() }
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let shared = crate::shared_folder(app);
    // A blank setting means the usual place (~/BridgeDeck Shared).
    let shared = if shared.trim().is_empty() { crate::study::default_shared() } else { PathBuf::from(shared.trim()) };
    Ok(shared.join(FOLDER))
}

fn manager(app: &AppHandle) -> BridgeLinkManager {
    app.state::<BridgeLinkManager>().inner().clone()
}

fn my_folder(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.join(folder_name(&manager(app).computer_name())))
}

/// Writes today's backup (replacing an earlier one from today) and drops the oldest past `KEEP`.
fn make(app: &AppHandle) -> Result<PathBuf, String> {
    let manager = manager(app);
    let made = now_ms();
    let backup = Backup {
        version: VERSION,
        made,
        computer: manager.computer_name(),
        notes: notes::all(&manager)?,
        events: calendar::all(&manager)?,
        settings: crate::read_saved_config(app).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok()),
    };
    let dir = my_folder(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make the backups folder: {e}"))?;
    let path = dir.join(format!("{}.json", date_of(made)));
    let raw = serde_json::to_string(&backup).map_err(|e| e.to_string())?;
    let partial = path.with_extension("json.partial");
    fs::write(&partial, raw).and_then(|_| fs::rename(&partial, &path)).map_err(|e| format!("Couldn't write the backup: {e}"))?;
    prune(&dir, KEEP);
    Ok(path)
}

/// Keeps the newest `keep` backups in `dir` (names sort by date).
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| is_backup_name(p)).collect();
    files.sort();
    let extra = files.len().saturating_sub(keep);
    for old in files.into_iter().take(extra) {
        let _ = fs::remove_file(old);
    }
}

fn is_backup_name(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.len() == 15 && name.ends_with(".json") && name[..10].chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
}

/// Makes today's backup if there isn't one yet; checked at start and every hour.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // Let BridgeLink load its notes first.
        std::thread::sleep(Duration::from_secs(90));
        loop {
            if let Ok(dir) = my_folder(&app) {
                let today = dir.join(format!("{}.json", date_of(now_ms())));
                let has_notes = notes::all(&manager(&app)).map(|n| !n.is_empty()).unwrap_or(false);
                if !today.exists() && has_notes {
                    let _ = make(&app);
                }
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}

#[tauri::command]
pub fn backups_list(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let root = root(&app)?;
    let mine = folder_name(&manager(&app).computer_name());
    let mut out = Vec::new();
    for computer in fs::read_dir(&root).into_iter().flatten().flatten().filter(|e| e.path().is_dir()) {
        let folder = computer.file_name().to_string_lossy().to_string();
        for file in fs::read_dir(computer.path()).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| is_backup_name(p)) {
            let Ok(raw) = fs::read_to_string(&file) else { continue };
            let Ok(backup) = serde_json::from_str::<Backup>(&raw) else { continue };
            out.push(BackupInfo {
                path: file.to_string_lossy().to_string(),
                computer: if backup.computer.is_empty() { folder.clone() } else { backup.computer },
                date: file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                made: backup.made,
                notes: backup.notes.iter().filter(|n| !n.deleted).count(),
                events: backup.events.iter().filter(|e| !e.deleted).count(),
                bytes: raw.len() as u64,
                mine: folder == mine,
            });
        }
    }
    out.sort_by(|a, b| b.made.cmp(&a.made));
    Ok(out)
}

#[tauri::command]
pub fn backup_now(app: AppHandle) -> Result<String, String> {
    make(&app).map(|p| p.to_string_lossy().to_string())
}

/// Restores from a backup in the backups folder: notes, events, and (returned for the window to
/// apply, from this computer's own backups only) settings.
#[tauri::command]
pub fn backup_restore(app: AppHandle, path: String, notes: bool, events: bool, settings: bool) -> Result<Restored, String> {
    let root = root(&app)?.canonicalize().map_err(|_| "There are no backups yet")?;
    let file = PathBuf::from(&path).canonicalize().map_err(|_| "That backup is gone")?;
    if !file.starts_with(&root) || !is_backup_name(&file) {
        return Err("That isn't one of BridgeDeck's backups".into());
    }
    let backup: Backup = serde_json::from_str(&fs::read_to_string(&file).map_err(|e| e.to_string())?).map_err(|_| "That backup can't be read")?;
    // A safety copy of how things are now, first.
    let _ = make(&app);
    let manager = manager(&app);
    let mine = file.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy() == folder_name(&manager.computer_name())).unwrap_or(false);
    Ok(Restored {
        notes: if notes { notes::restore_all(&manager, backup.notes)? } else { 0 },
        events: if events { calendar::restore_all(&manager, backup.events)? } else { 0 },
        settings: if settings && mine { backup.settings } else { None },
    })
}

// ---- One file to carry everything: notes, calendar, settings, circuits and programs ----

/// The shared-folder parts an export carries (each its top-level files and subfolders, without the
/// version history).
const CARRIED: &[&str] = &["Circuits", "Code"];
const MAX_IMPORT_FILE: u64 = 20 * 1024 * 1024;

/// Writes `backup` and the carried folders under `shared` into a zip at `to`. Returns how many
/// circuits and programs went in.
fn write_export(backup: &[u8], shared: &Path, to: &Path) -> Result<usize, String> {
    use std::io::Write;
    let file = fs::File::create(to).map_err(|e| format!("Couldn't write {}: {e}", to.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("backup.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(backup).map_err(|e| e.to_string())?;
    let mut count = 0;
    fn walk(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // .history and hidden files
            }
            if p.is_dir() {
                walk(&p, base, out);
            } else if p.is_file() {
                out.push(p.strip_prefix(base).map(Path::to_path_buf).unwrap_or(p));
            }
        }
    }
    for part in CARRIED {
        let mut files = Vec::new();
        walk(&shared.join(part), shared, &mut files);
        for rel in files {
            let Ok(bytes) = fs::read(shared.join(&rel)) else { continue };
            zip.start_file(rel.to_string_lossy().replace('\\', "/"), opts).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(count)
}

/// Reads an export: its backup, and puts its circuits and programs back under `shared` (a file
/// that's already there with other contents is kept, and the imported one saved beside it).
fn read_export(from: &Path, shared: &Path) -> Result<(Backup, usize), String> {
    use std::io::Read;
    let file = fs::File::open(from).map_err(|e| format!("Couldn't open {}: {e}", from.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "That isn't a BridgeDeck export (not a zip file)")?;
    let mut backup: Option<Backup> = None;
    let mut count = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        if entry.is_dir() || entry.size() > MAX_IMPORT_FILE {
            continue;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if rel == Path::new("backup.json") {
            backup = Some(serde_json::from_slice(&bytes).map_err(|_| "The export's backup can't be read")?);
            continue;
        }
        if !CARRIED.iter().any(|part| rel.starts_with(part)) {
            continue;
        }
        let mut dest = shared.join(&rel);
        if dest.exists() {
            if fs::read(&dest).is_ok_and(|now| now == bytes) {
                continue;
            }
            let stem = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let (name, ext) = stem.split_once('.').map(|(a, b)| (a.to_string(), format!(".{b}"))).unwrap_or((stem.clone(), String::new()));
            dest = dest.with_file_name(format!("{name} (imported){ext}"));
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok((backup.ok_or("That isn't a BridgeDeck export (no backup in it)")?, count))
}

fn shared_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.parent().ok_or("No shared folder")?.to_path_buf())
}

/// Saves everything (notes, calendar, settings, circuits, programs) as one .zip file at `path`.
#[tauri::command]
pub async fn backup_export(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let made = make(&app)?;
        let backup = fs::read(&made).map_err(|e| e.to_string())?;
        let n = write_export(&backup, &shared_root(&app)?, Path::new(&path))?;
        crate::activity::info("backup", &format!("Exported everything to {path}."));
        Ok(format!("Saved notes, calendar, settings and {n} circuit and program file{} in {path}.", if n == 1 { "" } else { "s" }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Brings back an export: notes and events (as new edits), its circuits and programs, and its
/// settings (returned for the window to apply) when asked.
#[tauri::command]
pub async fn backup_import(app: AppHandle, path: String, settings: bool) -> Result<Restored, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (backup, files) = read_export(Path::new(&path), &shared_root(&app)?)?;
        let _ = make(&app); // a safety copy of how things are now
        let manager = manager(&app);
        let restored = Restored {
            notes: notes::restore_all(&manager, backup.notes)?,
            events: calendar::restore_all(&manager, backup.events)?,
            settings: if settings { backup.settings } else { None },
        };
        crate::activity::info("backup", &format!("Imported {path}: {} notes, {} events, {files} circuit and program files.", restored.notes, restored.events));
        Ok(restored)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backups_are_named_by_date_and_the_oldest_go() {
        assert_eq!(date_of(0), "1970-01-01");
        assert_eq!(date_of(1_791_244_800_000), "2026-10-06");
        assert_eq!(date_of(951_782_400_000), "2000-02-29");
        assert_eq!(folder_name("Adoniyas’s MacBook/Pro"), "Adoniyas_s MacBook_Pro");
        assert_eq!(folder_name("../.."), "_");
        assert!(is_backup_name(Path::new("/x/2026-10-06.json")) && !is_backup_name(Path::new("/x/notes.json")) && !is_backup_name(Path::new("/x/2026-10-06.json.partial")));
        let dir = std::env::temp_dir().join(format!("bd-backups-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for day in 1..=20 {
            fs::write(dir.join(format!("2026-09-{day:02}.json")), "{}").unwrap();
        }
        fs::write(dir.join("keep-me.txt"), "").unwrap();
        prune(&dir, KEEP);
        let mut left: Vec<String> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        left.sort();
        assert_eq!(left.len(), KEEP + 1);
        assert_eq!(left[0], "2026-09-07.json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_export_carries_circuits_and_programs_and_comes_back_without_clobbering() {
        let base = std::env::temp_dir().join(format!("bd-export-{}", std::process::id()));
        let (a, b) = (base.join("a"), base.join("b"));
        fs::create_dir_all(a.join("Circuits/.history/x")).unwrap();
        fs::create_dir_all(a.join("Code")).unwrap();
        fs::write(a.join("Circuits/adder.circuit.json"), "{\"v\":1}").unwrap();
        fs::write(a.join("Circuits/.history/x/1.circuit.json"), "old").unwrap();
        fs::write(a.join("Code/hello.py"), "print('hi')").unwrap();
        fs::write(a.join("Notes.txt"), "not carried").unwrap();
        let backup = serde_json::to_vec(&Backup { version: VERSION, made: 1, computer: "Mac".into(), notes: vec![], events: vec![], settings: Some(serde_json::json!({"theme": "dark"})) }).unwrap();
        let zip = base.join("export.zip");
        assert_eq!(write_export(&backup, &a, &zip).unwrap(), 2);
        // On the other computer: hello.py is there with other code, adder.circuit.json isn't.
        fs::create_dir_all(b.join("Code")).unwrap();
        fs::write(b.join("Code/hello.py"), "print('mine')").unwrap();
        let (restored, n) = read_export(&zip, &b).unwrap();
        assert_eq!(restored.computer, "Mac");
        assert_eq!(restored.settings, Some(serde_json::json!({"theme": "dark"})));
        assert_eq!(n, 2);
        assert_eq!(fs::read_to_string(b.join("Circuits/adder.circuit.json")).unwrap(), "{\"v\":1}");
        assert_eq!(fs::read_to_string(b.join("Code/hello.py")).unwrap(), "print('mine')");
        assert_eq!(fs::read_to_string(b.join("Code/hello (imported).py")).unwrap(), "print('hi')");
        assert!(!b.join("Circuits/.history").exists() && !b.join("Notes.txt").exists());
        assert!(read_export(&base.join("a/Code/hello.py"), &b).is_err());
        let _ = fs::remove_dir_all(&base);
    }
}
