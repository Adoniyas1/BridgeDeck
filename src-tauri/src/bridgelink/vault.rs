//! The vault: every note is also a Markdown file in a folder on this computer, so Obsidian, Logseq,
//! Zettlr or any editor can open them. Each computer keeps its own copy of the folder; notes travel
//! between computers through the note sync (`notes.rs`), never by syncing the folder, so the two
//! kinds of sync can't fight.
//!
//! Every few seconds: files changed outside BridgeDeck are read back into their notes (a renamed
//! or moved file renames the note or changes its folder; a new file becomes a new note; a deleted
//! file deletes its note), then notes that changed are written out. A note's id lives in the file's
//! frontmatter (`bridgedeck: <id>`); other frontmatter the user adds is kept.

use super::*;
use sha2::{Digest, Sha256};

const STATE_FILE: &str = "vault.json";
const SCAN_EVERY: Duration = Duration::from_secs(3);
/// A scan that finds more of the vault gone than this is treated as the folder being unavailable,
/// not as the user deleting notes.
const MAX_DELETE_SHARE: f64 = 0.2;

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FileState {
    /// Path under the vault, with `/` between folders.
    rel: String,
    /// Hash of what was last written or read.
    hash: String,
    /// When BridgeDeck last wrote or read it (ms).
    synced: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VaultState {
    enabled: bool,
    path: String,
    files: HashMap<String, FileState>,
}

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub enabled: bool,
    pub path: String,
    pub files: usize,
    pub error: Option<String>,
}

static STATE: Mutex<Option<VaultState>> = Mutex::new(None);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// A file or folder name made safe on every system.
fn clean_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']') { '-' } else { c }).collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().chars().take(120).collect::<String>();
    if trimmed.is_empty() { "Untitled".into() } else { trimmed }
}

fn folder_rel(folder: &str) -> String {
    folder.split('/').map(str::trim).filter(|p| !p.is_empty()).map(clean_name).collect::<Vec<_>>().join("/")
}

/// The file for each note: folder/Title.md, numbered when two notes would share a name.
fn plan_paths(notes: &[notes::Note]) -> HashMap<String, String> {
    let mut sorted: Vec<&notes::Note> = notes.iter().collect();
    sorted.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    let mut taken = std::collections::HashSet::new();
    let mut out = HashMap::new();
    for note in sorted {
        let folder = folder_rel(&note.folder);
        let base = clean_name(&notes::display_title(note));
        let mut n = 1;
        loop {
            let name = if n == 1 { format!("{base}.md") } else { format!("{base} ({n}).md") };
            let rel = if folder.is_empty() { name } else { format!("{folder}/{name}") };
            if taken.insert(rel.to_lowercase()) {
                out.insert(note.id.clone(), rel);
                break;
            }
            n += 1;
        }
    }
    out
}

/// Splits frontmatter from the body: (bridgedeck id, kind, other frontmatter lines, body).
fn split_file(text: &str) -> (Option<String>, Option<String>, Vec<String>, String) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n");
    let Some(rest) = text.strip_prefix("---\n") else { return (None, None, Vec::new(), text) };
    let Some(end) = rest.find("\n---") else { return (None, None, Vec::new(), text) };
    let (front, after) = (&rest[..end], &rest[end + 4..]);
    let body = after.strip_prefix('\n').unwrap_or(after).to_string();
    let (mut id, mut kind, mut other) = (None, None, Vec::new());
    for line in front.lines() {
        match line.split_once(':') {
            Some((key, value)) if key.trim() == "bridgedeck" => id = Some(value.trim().trim_matches('"').to_string()).filter(|v| !v.is_empty()),
            Some((key, value)) if key.trim() == "bridgedeck-kind" => kind = Some(value.trim().to_string()),
            _ => other.push(line.to_string()),
        }
    }
    (id, kind, other, body)
}

fn file_text(note: &notes::Note, other_front: &[String]) -> String {
    let mut front = vec![format!("bridgedeck: {}", note.id)];
    if note.kind == "list" {
        front.push("bridgedeck-kind: list".into());
    }
    front.extend(other_front.iter().cloned());
    format!("---\n{}\n---\n{}\n", front.join("\n"), notes::to_markdown(note))
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Markdown files under the vault (Obsidian's own folders and trash are skipped).
fn vault_files(root: &Path) -> Vec<String> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("md")))
        .filter_map(|e| e.path().strip_prefix(root).ok().map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/")))
        .take(20_000)
        .collect()
}

fn title_and_folder(rel: &str) -> (String, String) {
    let (folder, file) = rel.rsplit_once('/').unwrap_or(("", rel));
    let title = file.strip_suffix(".md").or_else(|| file.strip_suffix(".MD")).unwrap_or(file).to_string();
    (title, folder.to_string())
}

/// What one scan did, for tests and the status line.
#[derive(Debug, Default, PartialEq)]
pub struct ScanReport {
    pub imported: usize,
    pub created: usize,
    pub deleted_notes: usize,
    pub written: usize,
    pub removed_files: usize,
}

/// One pass: files changed outside → notes, then notes → files.
pub fn scan(manager: &BridgeLinkManager, root: &Path) -> Result<ScanReport, String> {
    let mut report = ScanReport::default();
    fs::create_dir_all(root).map_err(|e| format!("Can't use the vault folder: {e}"))?;
    let mut state = STATE.lock().map_err(|_| "vault state poisoned")?.clone().unwrap_or_default();

    // ---- 1. Changes made outside BridgeDeck ----
    let notes_now = manager.lock()?.notes.list();
    let by_id: HashMap<String, notes::Note> = notes_now.iter().map(|n| (n.id.clone(), n.clone())).collect();
    let files = vault_files(root);
    let mut seen_ids = std::collections::HashSet::new();
    for rel in &files {
        let path = root.join(rel);
        let known = state.files.iter().find(|(_, f)| &f.rel == rel).map(|(id, f)| (id.clone(), f.clone()));
        // Unchanged since BridgeDeck last touched it: nothing to read.
        if let Some((id, file)) = &known {
            if mtime_ms(&path) <= file.synced {
                seen_ids.insert(id.clone());
                continue;
            }
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let (id, kind, _, body) = split_file(&text);
        let file_hash = hash(&text);
        let (title, folder) = title_and_folder(rel);
        match id.filter(|id| by_id.contains_key(id) || state.files.contains_key(id)) {
            Some(id) => {
                seen_ids.insert(id.clone());
                let previous = state.files.get(&id).cloned().unwrap_or_default();
                if previous.hash == file_hash && previous.rel == *rel {
                    continue;
                }
                let Some(note) = by_id.get(&id) else { continue };
                // Both changed: the newer one wins.
                let note_newer = note.updated() > previous.synced && note.updated() > mtime_ms(&path);
                if note_newer {
                    continue;
                }
                let body_changed = previous.hash != file_hash;
                let moved = previous.rel != *rel;
                let (id2, body2, title2, folder2) = (id.clone(), body.clone(), title.clone(), folder.clone());
                notes::local(manager, move |store, device, now| {
                    if body_changed {
                        store.replace_markdown(&id2, &body2, device, now)?;
                    }
                    if moved {
                        store.apply(notes::NotePatch { id: id2.clone(), title: Some(title2), folder: Some(folder2), ..Default::default() }, device, now)?;
                    }
                    Ok(())
                })?;
                if moved && !previous.rel.is_empty() {
                    remove_empty_dirs(root, root.join(&previous.rel).parent());
                }
                state.files.insert(id.clone(), FileState { rel: rel.clone(), hash: file_hash, synced: now_ms() });
                report.imported += 1;
            }
            None => {
                // A new file: a new note.
                let kind = if kind.as_deref() == Some("list") || body.lines().filter(|l| !l.trim().is_empty()).all(|l| l.trim_start().starts_with("- [")) && !body.trim().is_empty() { "list" } else { "note" };
                let (body2, title2, folder2) = (body.clone(), title.clone(), folder.clone());
                let note = notes::local(manager, move |store, device, now| store.create_from_markdown(None, kind, &title2, &folder2, &body2, device, now))?;
                seen_ids.insert(note.id.clone());
                // Written back with its id below; until then, remember where it is.
                state.files.insert(note.id.clone(), FileState { rel: rel.clone(), hash: String::new(), synced: 0 });
                report.created += 1;
            }
        }
    }

    // Files that disappeared: their notes are deleted, unless most of the vault vanished at once.
    let missing: Vec<String> = state.files.iter().filter(|(id, f)| !seen_ids.contains(*id) && !f.hash.is_empty() && !root.join(&f.rel).exists()).map(|(id, _)| id.clone()).collect();
    let limit = ((state.files.len() as f64) * MAX_DELETE_SHARE).ceil().max(3.0) as usize;
    if missing.len() <= limit {
        for id in &missing {
            if by_id.contains_key(id) {
                let id2 = id.clone();
                notes::local(manager, move |store, _, now| Ok(store.delete(&id2, now)))?;
                report.deleted_notes += 1;
            }
            state.files.remove(id);
        }
    }

    // ---- 2. Notes → files ----
    let notes_now = manager.lock()?.notes.list();
    let paths = plan_paths(&notes_now);
    for note in &notes_now {
        let rel = &paths[&note.id];
        let previous = state.files.get(&note.id).cloned();
        let other_front = previous.as_ref().and_then(|p| fs::read_to_string(root.join(&p.rel)).ok()).map(|t| split_file(&t).2).unwrap_or_default();
        let text = file_text(note, &other_front);
        let text_hash = hash(&text);
        if previous.as_ref().is_some_and(|p| p.hash == text_hash && &p.rel == rel) && root.join(rel).exists() {
            continue;
        }
        let target = root.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if let Some(previous) = previous.filter(|p| &p.rel != rel) {
            let old = root.join(&previous.rel);
            if old.exists() && !target.exists() {
                let _ = fs::rename(&old, &target);
            }
            remove_empty_dirs(root, old.parent());
        }
        fs::write(&target, &text).map_err(|e| format!("Can't write {rel}: {e}"))?;
        state.files.insert(note.id.clone(), FileState { rel: rel.clone(), hash: text_hash, synced: mtime_ms(&target).max(now_ms()) });
        report.written += 1;
    }
    // Notes deleted in BridgeDeck (or on the other computer): their files go, unless edited since.
    let live: std::collections::HashSet<&str> = notes_now.iter().map(|n| n.id.as_str()).collect();
    let gone: Vec<(String, FileState)> = state.files.iter().filter(|(id, _)| !live.contains(id.as_str())).map(|(id, f)| (id.clone(), f.clone())).collect();
    for (id, file) in gone {
        let path = root.join(&file.rel);
        if fs::read_to_string(&path).map(|t| hash(&t) == file.hash).unwrap_or(true) {
            let _ = fs::remove_file(&path);
            remove_empty_dirs(root, path.parent());
            report.removed_files += 1;
        }
        state.files.remove(&id);
    }

    if let Ok(mut stored) = STATE.lock() {
        let enabled = stored.as_ref().map(|s| (s.enabled, s.path.clone()));
        if let Some((enabled, path)) = enabled {
            state.enabled = enabled;
            state.path = path;
        }
        *stored = Some(state);
    }
    Ok(report)
}

fn remove_empty_dirs(root: &Path, mut dir: Option<&Path>) {
    while let Some(d) = dir {
        if d == root || !d.starts_with(root) || fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

fn save_state(manager: &BridgeLinkManager) {
    let Some(dir) = manager.lock().ok().and_then(|r| r.storage_dir.clone()) else { return };
    if let Some(state) = STATE.lock().ok().and_then(|s| s.clone()) {
        if let Ok(raw) = serde_json::to_string(&state) {
            let _ = secure_write(&dir.join(STATE_FILE), &raw);
        }
    }
}

fn default_path(app: Option<&AppHandle>) -> String {
    app.and_then(|a| a.path().document_dir().ok()).map(|d| d.join("BridgeDeck Vault").to_string_lossy().to_string()).unwrap_or_default()
}

/// Loads the vault settings and keeps the vault in step while BridgeLink runs.
pub(super) fn spawn(manager: BridgeLinkManager, shutdown: Arc<AtomicBool>) {
    let (dir, app) = match manager.lock() {
        Ok(r) => (r.storage_dir.clone(), r.app.clone()),
        Err(_) => return,
    };
    let mut state = dir.as_ref().and_then(|d| load_json::<VaultState>(&d.join(STATE_FILE))).unwrap_or_else(|| VaultState { enabled: true, ..Default::default() });
    if state.path.is_empty() {
        state.path = default_path(app.as_ref());
    }
    if let Ok(mut stored) = STATE.lock() {
        *stored = Some(state);
    }
    thread::spawn(move || {
        while !shutdown.load(Ordering::Relaxed) {
            let settings = STATE.lock().ok().and_then(|s| s.as_ref().map(|s| (s.enabled, s.path.clone())));
            if let Some((true, path)) = settings.filter(|(_, p)| !p.is_empty()) {
                let result = scan(&manager, Path::new(&path));
                let changed = result.as_ref().map(|r| *r != ScanReport::default()).unwrap_or(false);
                if let Ok(mut error) = LAST_ERROR.lock() {
                    *error = result.err();
                }
                if changed {
                    save_state(&manager);
                    if let Some(app) = manager.lock().ok().and_then(|r| r.app.clone()) {
                        use tauri::Emitter;
                        let _ = app.emit("notes-changed", ());
                    }
                }
            }
            thread::sleep(SCAN_EVERY);
        }
    });
}

/// The vault's settings now (for Mimir).
pub fn current_status() -> VaultStatus {
    status()
}

fn status() -> VaultStatus {
    let state = STATE.lock().ok().and_then(|s| s.clone()).unwrap_or_default();
    VaultStatus { enabled: state.enabled, path: state.path, files: state.files.len(), error: LAST_ERROR.lock().ok().and_then(|e| e.clone()) }
}

/// The vault settings; with arguments, changes them. A new folder starts fresh (every note is
/// written there); the old folder is left as it is.
#[tauri::command]
pub fn vault_settings(enabled: Option<bool>, path: Option<String>, manager: State<'_, BridgeLinkManager>) -> Result<VaultStatus, String> {
    if let Ok(mut stored) = STATE.lock() {
        let state = stored.get_or_insert_with(|| VaultState { enabled: true, ..Default::default() });
        if let Some(enabled) = enabled {
            state.enabled = enabled;
        }
        if let Some(path) = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
            if path != state.path {
                state.path = path;
                state.files.clear();
            }
        }
    }
    save_state(&manager);
    Ok(status())
}

#[cfg(test)]
pub(super) fn reset_for_test(path: &Path) {
    *STATE.lock().unwrap() = Some(VaultState { enabled: true, path: path.to_string_lossy().to_string(), files: HashMap::new() });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> BridgeLinkManager {
        let manager = BridgeLinkManager::default();
        manager.lock().unwrap().instance_id = "mac".into();
        manager
    }

    fn create(manager: &BridgeLinkManager, kind: &str, title: &str, folder: &str, md: &str) -> notes::Note {
        let (kind, title, folder, md) = (kind.to_string(), title.to_string(), folder.to_string(), md.to_string());
        notes::local(manager, move |store, device, now| store.create_from_markdown(None, &kind, &title, &folder, &md, device, now)).unwrap()
    }

    fn bump_mtime(path: &Path) {
        // File times can be coarse; make sure an edit looks newer than BridgeDeck's last write.
        let later = std::time::SystemTime::now() + Duration::from_secs(5);
        let _ = fs::File::options().write(true).open(path).and_then(|f| f.set_modified(later));
    }

    #[test]
    fn notes_become_files_and_edits_outside_come_back() {
        let _turn = TEST_TURN.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("bd-vault-{}", Uuid::new_v4()));
        reset_for_test(&root);
        let manager = node();
        let thesis = create(&manager, "list", "Thesis", "School/Year 3", "- [ ] Ch 11\n  - [ ] Ch 11.1");
        create(&manager, "note", "Ideas: big?", "", "See [[Thesis]] #study\n\nSecond paragraph.");
        let report = scan(&manager, &root).unwrap();
        assert_eq!(report.written, 2);
        let file = root.join("School/Year 3/Thesis.md");
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.starts_with(&format!("---\nbridgedeck: {}\nbridgedeck-kind: list\n---\n", thesis.id)), "{text}");
        assert!(text.contains("- [ ] Ch 11\n  - [ ] Ch 11.1"));
        assert!(root.join("Ideas- big-.md").exists());
        // Nothing changed: nothing written.
        assert_eq!(scan(&manager, &root).unwrap(), ScanReport::default());

        // Edited in Obsidian, with a property added: the note follows, the property stays.
        fs::write(&file, text.replace("---\n- [ ] Ch 11", "tags: [school]\n---\n- [x] Ch 11")).unwrap();
        bump_mtime(&file);
        let report = scan(&manager, &root).unwrap();
        assert_eq!(report.imported, 1, "{report:?}");
        let note = manager.lock().unwrap().notes.list().into_iter().find(|n| n.id == thesis.id).unwrap();
        assert!(notes::to_markdown(&note).starts_with("- [x] Ch 11"));
        assert!(fs::read_to_string(&file).unwrap().contains("tags: [school]"));

        // Renamed and moved in Obsidian: the note's title and folder follow.
        let moved = root.join("Archive/Old thesis.md");
        fs::create_dir_all(moved.parent().unwrap()).unwrap();
        fs::rename(&file, &moved).unwrap();
        bump_mtime(&moved);
        scan(&manager, &root).unwrap();
        let note = manager.lock().unwrap().notes.list().into_iter().find(|n| n.id == thesis.id).unwrap();
        assert_eq!((note.title.as_str(), note.folder.as_str()), ("Old thesis", "Archive"));
        assert!(!root.join("School").exists(), "empty folders are tidied");

        // A new file made outside becomes a note and gets its id.
        let new = root.join("Inbox/Groceries.md");
        fs::create_dir_all(new.parent().unwrap()).unwrap();
        fs::write(&new, "- [ ] milk\n- [ ] eggs\n").unwrap();
        let report = scan(&manager, &root).unwrap();
        assert_eq!(report.created, 1);
        let groceries = manager.lock().unwrap().notes.list().into_iter().find(|n| n.title == "Groceries").unwrap();
        assert_eq!((groceries.kind.as_str(), groceries.folder.as_str()), ("list", "Inbox"));
        assert!(fs::read_to_string(&new).unwrap().contains(&format!("bridgedeck: {}", groceries.id)));

        // Deleted outside: the note goes. Deleted in BridgeDeck: the file goes.
        fs::remove_file(&new).unwrap();
        assert_eq!(scan(&manager, &root).unwrap().deleted_notes, 1);
        assert!(!manager.lock().unwrap().notes.list().iter().any(|n| n.id == groceries.id));
        let id = thesis.id.clone();
        notes::local(&manager, move |store, _, now| Ok(store.delete(&id, now))).unwrap();
        assert_eq!(scan(&manager, &root).unwrap().removed_files, 1);
        assert!(!moved.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_vanished_vault_does_not_delete_every_note() {
        let _turn = TEST_TURN.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("bd-vault-{}", Uuid::new_v4()));
        reset_for_test(&root);
        let manager = node();
        for i in 0..10 {
            create(&manager, "note", &format!("Note {i}"), "", "text");
        }
        scan(&manager, &root).unwrap();
        fs::remove_dir_all(&root).unwrap();
        let report = scan(&manager, &root).unwrap();
        assert_eq!(report.deleted_notes, 0);
        assert_eq!(manager.lock().unwrap().notes.list().len(), 10);
        assert_eq!(report.written, 10, "the files are written again");
        let _ = fs::remove_dir_all(root);
    }

    /// The vault state is shared by the tests in this module.
    static TEST_TURN: Mutex<()> = Mutex::new(());
}
