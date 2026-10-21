//! Notes and checklists, kept on every paired computer.
//!
//! A note is a list of blocks (a paragraph, heading, list item, checklist item…), each with its own id
//! and last-change time, so two computers editing the same note merge block by block: the newer
//! version of each block wins, and a deleted block stays as a marker so the deletion spreads.
//!
//! Sync is pulled: every change here gets the next number in this store's sequence, and a paired
//! computer asks for "everything after N" (`POST /notes/pull`), page by page. A local change pokes the
//! paired computers (`POST /notes/poke`) so they pull at once; upkeep pulls every 30 seconds anyway.
//! Everything here is data: nothing in a note is ever run.

use super::*;

const MAX_NOTES: usize = 5_000;
const MAX_BLOCKS: usize = 3_000;
const MAX_TEXT: usize = 20_000;
const MAX_TITLE: usize = 300;
const MAX_INDENT: u8 = 4;
/// Keeps each pull answer well under the link's 1 MB frame.
const PAGE_BYTES: usize = 600 * 1024;
const BLOCK_KINDS: &[&str] = &["p", "h1", "h2", "h3", "li", "ol", "todo", "quote", "code", "drawing", "graph", "python", "locked", "ink", "image"];

/// A block kind this build may not know yet (made by a newer BridgeDeck): kept as it is, so a
/// computer that hasn't been updated doesn't turn it into a paragraph and sync that back. Only
/// short lowercase names are kept; anything else becomes a paragraph.
fn kept_kind(kind: String) -> String {
    let plausible = !kind.is_empty() && kind.len() <= 24 && kind.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if BLOCK_KINDS.contains(&kind.as_str()) || plausible { kind } else { "p".into() }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub checked: bool,
    /// Nesting under the block above: sub-tasks and sub-points (0 = top level).
    #[serde(default)]
    pub indent: u8,
    /// Checklist items: when it's due (ms since 1970), shown in the calendar and reminded.
    #[serde(default)]
    pub due: Option<u64>,
    /// Order within the note: blocks sort by this string (a fractional index).
    #[serde(default)]
    pub pos: String,
    #[serde(default)]
    pub updated: u64,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub pinned: bool,
    /// Made by Mimir: shown in Mimir's own section of Notes, apart from the person's notes.
    #[serde(default)]
    pub mimir: bool,
    /// "note" or "list" (a checklist first).
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub title_updated: u64,
    /// When folder, pin, kind or deletion last changed.
    #[serde(default)]
    pub meta_updated: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub blocks: Vec<Block>,
    /// This store's change number for the note (not sent between computers' merges as truth).
    #[serde(default)]
    pub seq: u64,
}

impl Note {
    /// The newest change to anything in the note.
    pub fn updated(&self) -> u64 {
        self.blocks.iter().map(|b| b.updated).chain([self.title_updated, self.meta_updated, self.created]).max().unwrap_or(0)
    }
}

/// What the UI changed in a note. Fields left out stay as they are.
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NotePatch {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub mimir: Option<bool>,
    #[serde(default)]
    pub kind: Option<String>,
    /// Blocks added or edited.
    #[serde(default)]
    pub blocks: Vec<Block>,
    /// Ids of blocks removed.
    #[serde(default)]
    pub removed: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    notes: Vec<Note>,
    seq: u64,
    /// Highest change number pulled from each paired computer.
    seen: HashMap<String, u64>,
}

#[derive(Default)]
pub struct NoteStore {
    notes: HashMap<String, Note>,
    seq: u64,
    seen: HashMap<String, u64>,
}

impl NoteStore {
    /// A note by id (deleted ones too).
    pub fn get(&self, id: &str) -> Option<&Note> {
        self.notes.get(id)
    }
}

fn clean_text(value: &str, max: usize) -> String {
    value.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).take(max).collect()
}

fn clean_id(value: &str) -> Option<String> {
    let id: String = value.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    (!id.is_empty()).then_some(id)
}

/// Cleans a block from the network or the UI; None if it can't be kept.
fn sanitize_block(block: Block) -> Option<Block> {
    Some(Block {
        id: clean_id(&block.id)?,
        kind: kept_kind(block.kind),
        text: clean_text(&block.text, MAX_TEXT),
        checked: block.checked,
        indent: block.indent.min(MAX_INDENT),
        due: block.due,
        pos: block.pos.chars().filter(|c| c.is_ascii_alphanumeric()).take(64).collect(),
        updated: block.updated,
        by: clean_text(&block.by, 64),
        deleted: block.deleted,
    })
}

fn sanitize_note(note: Note) -> Option<Note> {
    let mut seen = std::collections::HashSet::new();
    let blocks = note.blocks.into_iter().filter_map(sanitize_block).filter(|b| seen.insert(b.id.clone())).take(MAX_BLOCKS).collect();
    Some(Note {
        id: clean_id(&note.id)?,
        title: clean_text(&note.title, MAX_TITLE).replace(['\n', '\t'], " "),
        folder: clean_text(&note.folder, 80).replace(['\n', '\t'], " ").trim().to_string(),
        pinned: note.pinned,
        mimir: note.mimir,
        kind: if note.kind == "list" { "list".into() } else { "note".into() },
        created: note.created,
        title_updated: note.title_updated,
        meta_updated: note.meta_updated,
        deleted: note.deleted,
        blocks,
        seq: 0,
    })
}

/// Newer wins; equal times are settled by the device id so both computers pick the same one.
fn newer(a_time: u64, a_by: &str, b_time: u64, b_by: &str) -> bool {
    (a_time, a_by) > (b_time, b_by)
}

impl NoteStore {
    pub(super) fn load(dir: &Path) -> Self {
        let persisted = load_json::<Persisted>(&dir.join("notes.json")).unwrap_or_default();
        Self { notes: persisted.notes.into_iter().map(|n| (n.id.clone(), n)).collect(), seq: persisted.seq, seen: persisted.seen }
    }

    pub(super) fn save(&self, dir: Option<&PathBuf>) {
        let Some(dir) = dir else { return };
        let persisted = Persisted { notes: self.notes.values().cloned().collect(), seq: self.seq, seen: self.seen.clone() };
        if let Ok(raw) = serde_json::to_string(&persisted) {
            let _ = secure_write(&dir.join("notes.json"), &raw);
        }
    }

    fn bump(&mut self, id: &str) {
        self.seq += 1;
        let seq = self.seq;
        if let Some(note) = self.notes.get_mut(id) {
            note.seq = seq;
        }
    }

    /// Notes that aren't deleted, most recently changed first.
    pub fn list(&self) -> Vec<Note> {
        let mut notes: Vec<Note> = self.notes.values().filter(|n| !n.deleted).cloned().collect();
        notes.sort_by_key(|n| std::cmp::Reverse(n.updated()));
        notes
    }

    pub fn create(&mut self, kind: &str, folder: &str, device: &str, now: u64) -> Result<Note, String> {
        if self.notes.len() >= MAX_NOTES {
            return Err("There are too many notes; delete some first".into());
        }
        let id = Uuid::new_v4().to_string();
        let first = Block { id: Uuid::new_v4().to_string(), kind: if kind == "list" { "todo" } else { "p" }.into(), pos: "i".into(), updated: now, by: device.into(), ..Default::default() };
        let note = Note { id: id.clone(), kind: if kind == "list" { "list" } else { "note" }.into(), folder: clean_text(folder, 80), created: now, title_updated: now, meta_updated: now, blocks: vec![first], ..Default::default() };
        self.notes.insert(id.clone(), note);
        self.bump(&id);
        Ok(self.notes[&id].clone())
    }

    /// The whole edited note, turned into a patch (tests; the UI sends patches so it never undoes
    /// changes that arrived from another computer while it was editing).
    #[cfg(test)]
    pub fn save_from_ui(&mut self, edited: Note, device: &str, now: u64) -> Result<Note, String> {
        let current = self.notes.get(&edited.id).cloned().ok_or("That note no longer exists")?;
        let ids: std::collections::HashSet<&str> = edited.blocks.iter().map(|b| b.id.as_str()).collect();
        let patch = NotePatch {
            id: edited.id.clone(),
            title: Some(edited.title.clone()),
            folder: Some(edited.folder.clone()),
            pinned: Some(edited.pinned),
            mimir: Some(edited.mimir),
            kind: Some(edited.kind.clone()),
            removed: current.blocks.iter().filter(|b| !b.deleted && !ids.contains(b.id.as_str())).map(|b| b.id.clone()).collect(),
            blocks: edited.blocks,
        };
        self.apply(patch, device, now)
    }

    /// Applies what the UI changed: only the fields and blocks named in the patch.
    pub fn apply(&mut self, patch: NotePatch, device: &str, now: u64) -> Result<Note, String> {
        let current = self.notes.get(&patch.id).cloned().filter(|n| !n.deleted).ok_or("That note no longer exists")?;
        let mut next = current.clone();
        if let Some(title) = patch.title {
            let title = clean_text(&title, MAX_TITLE).replace(['\n', '\t'], " ");
            if title != next.title {
                next.title = title;
                next.title_updated = now;
            }
        }
        let folder = patch.folder.map(|f| clean_text(&f, 80).replace(['\n', '\t'], " ").trim().to_string()).unwrap_or_else(|| next.folder.clone());
        let pinned = patch.pinned.unwrap_or(next.pinned);
        let mimir = patch.mimir.unwrap_or(next.mimir);
        let kind = match patch.kind.as_deref() {
            Some("list") => "list".to_string(),
            Some(_) => "note".to_string(),
            None => next.kind.clone(),
        };
        if (folder.as_str(), pinned, mimir, kind.as_str()) != (next.folder.as_str(), next.pinned, next.mimir, next.kind.as_str()) {
            next.folder = folder;
            next.pinned = pinned;
            next.mimir = mimir;
            next.kind = kind;
            next.meta_updated = now;
        }
        for new in patch.blocks.into_iter().filter_map(sanitize_block) {
            match next.blocks.iter().position(|b| b.id == new.id) {
                Some(i) => {
                    let block = &mut next.blocks[i];
                    let differs = (new.kind.as_str(), new.text.as_str(), new.checked, new.indent, new.due, new.pos.as_str()) != (block.kind.as_str(), block.text.as_str(), block.checked, block.indent, block.due, block.pos.as_str());
                    if differs || block.deleted {
                        *block = Block { updated: now, by: device.into(), deleted: false, ..new };
                    }
                }
                None if next.blocks.len() < MAX_BLOCKS => next.blocks.push(Block { updated: now, by: device.into(), deleted: false, ..new }),
                None => {}
            }
        }
        for id in &patch.removed {
            if let Some(block) = next.blocks.iter_mut().find(|b| &b.id == id && !b.deleted) {
                block.deleted = true;
                block.text.clear();
                block.updated = now;
                block.by = device.into();
            }
        }
        if next != current {
            self.notes.insert(next.id.clone(), next.clone());
            self.bump(&next.id);
        }
        Ok(self.notes[&next.id].clone())
    }

    /// Puts a note back as it was in a backup. A note that still exists gets the backup's title,
    /// folder and blocks as a new edit (so it wins on the other computer too), and blocks added
    /// since are removed; a note deleted since comes back as a new note (its deletion has spread).
    pub fn restore(&mut self, backup: Note, device: &str, now: u64) -> Result<Note, String> {
        let blocks: Vec<Block> = backup.blocks.into_iter().filter(|b| !b.deleted).collect();
        let id = match self.notes.get(&backup.id).filter(|n| !n.deleted) {
            Some(current) => current.id.clone(),
            None => {
                let created = self.create(&backup.kind, &backup.folder, device, now)?;
                let first = created.blocks.iter().map(|b| b.id.clone()).collect::<Vec<_>>();
                // The new note's empty first block goes, unless the backup has a block with its id.
                self.apply(NotePatch { id: created.id.clone(), removed: first, ..Default::default() }, device, now)?;
                created.id
            }
        };
        let keep: std::collections::HashSet<&str> = blocks.iter().map(|b| b.id.as_str()).collect();
        let removed = self.notes[&id].blocks.iter().filter(|b| !b.deleted && !keep.contains(b.id.as_str())).map(|b| b.id.clone()).collect();
        let patch = NotePatch { id, title: Some(backup.title), folder: Some(backup.folder), pinned: Some(backup.pinned), mimir: Some(backup.mimir), kind: Some(backup.kind), removed, blocks };
        self.apply(patch, device, now)
    }

    pub fn delete(&mut self, id: &str, now: u64) -> bool {
        let Some(note) = self.notes.get_mut(id) else { return false };
        if note.deleted {
            return false;
        }
        note.deleted = true;
        note.meta_updated = now;
        // A deleted note keeps only its marker; its text doesn't linger on the other computer.
        note.blocks.clear();
        note.title.clear();
        self.bump(id);
        true
    }

    /// Merges a note from a paired computer. True if anything here changed.
    pub fn merge(&mut self, incoming: Note) -> bool {
        let Some(incoming) = sanitize_note(incoming) else { return false };
        let id = incoming.id.clone();
        let Some(current) = self.notes.get(&id).cloned() else {
            if self.notes.len() >= MAX_NOTES {
                return false;
            }
            self.notes.insert(id.clone(), incoming);
            self.bump(&id);
            return true;
        };
        let mut next = current.clone();
        if incoming.title_updated > current.title_updated {
            next.title = incoming.title.clone();
            next.title_updated = incoming.title_updated;
        }
        if incoming.meta_updated > current.meta_updated {
            next.folder = incoming.folder.clone();
            next.pinned = incoming.pinned;
            next.mimir = incoming.mimir;
            next.kind = incoming.kind.clone();
            next.deleted = incoming.deleted;
            next.meta_updated = incoming.meta_updated;
        }
        next.created = match (current.created, incoming.created) {
            (0, theirs) => theirs,
            (mine, 0) => mine,
            (mine, theirs) => mine.min(theirs),
        };
        if next.deleted {
            next.blocks.clear();
            next.title.clear();
        } else {
            for block in incoming.blocks {
                match next.blocks.iter().position(|b| b.id == block.id) {
                    Some(i) => {
                        let mine = &mut next.blocks[i];
                        if newer(block.updated, &block.by, mine.updated, &mine.by) {
                            *mine = block;
                        }
                    }
                    None if next.blocks.len() < MAX_BLOCKS => next.blocks.push(block),
                    None => {}
                }
            }
        }
        if next != current {
            self.notes.insert(id.clone(), next);
            self.bump(&id);
            true
        } else {
            false
        }
    }

    /// Notes changed after `since` in this store, oldest change first, one page at a time.
    pub fn changes_since(&self, since: u64) -> PullAnswer {
        // Asked for more than this store ever had: it was reset, so send everything again.
        let since = if since > self.seq { 0 } else { since };
        let mut changed: Vec<&Note> = self.notes.values().filter(|n| n.seq > since).collect();
        changed.sort_by_key(|n| n.seq);
        let mut notes = Vec::new();
        let mut bytes = 0;
        let mut upto = since;
        for note in changed {
            let size = serde_json::to_string(note).map(|s| s.len()).unwrap_or(0);
            if !notes.is_empty() && bytes + size > PAGE_BYTES {
                return PullAnswer { notes, upto, more: true };
            }
            bytes += size;
            upto = note.seq;
            notes.push(note.clone());
        }
        PullAnswer { notes, upto, more: false }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullAnswer {
    pub notes: Vec<Note>,
    /// Ask for changes after this next time.
    pub upto: u64,
    pub more: bool,
}

#[derive(Deserialize)]
pub struct PullRequest {
    pub since: u64,
}

/// A paired computer asked for this store's changes.
pub(super) fn answer_pull(manager: &BridgeLinkManager, body: &str) -> Result<String, String> {
    let request: PullRequest = serde_json::from_str(body).map_err(|_| "Invalid notes request".to_string())?;
    let runtime = manager.lock()?;
    serde_json::to_string(&runtime.notes.changes_since(request.since)).map_err(|e| e.to_string())
}

/// Pulls a paired computer's changes into this store.
pub(super) fn pull_from(manager: &BridgeLinkManager, instance_id: &str) -> Result<usize, String> {
    let mut merged = 0;
    for _ in 0..50 {
        let since = manager.lock()?.notes.seen.get(instance_id).copied().unwrap_or(0);
        let answer: PullAnswer = peer::pull_notes(manager, instance_id, since)?;
        let mut runtime = manager.lock()?;
        let mut changed = false;
        for note in answer.notes {
            changed |= runtime.notes.merge(note);
        }
        runtime.notes.seen.insert(instance_id.to_string(), answer.upto);
        runtime.notes.save(runtime.storage_dir.as_ref());
        if changed {
            merged += 1;
            if let Some(app) = runtime.app.clone() {
                use tauri::Emitter;
                let _ = app.emit("notes-changed", ());
            }
        }
        if !answer.more {
            break;
        }
    }
    Ok(merged)
}

/// Pulls from every paired computer (upkeep, and after a poke).
pub(super) fn pull_all(manager: &BridgeLinkManager) {
    let peers: Vec<String> = manager.lock().map(|r| r.paired.keys().cloned().collect()).unwrap_or_default();
    for peer in peers {
        let _ = pull_from(manager, &peer);
    }
}

/// Saves after a local change and pokes the paired computers so they pull it now.
fn changed(manager: &BridgeLinkManager) {
    let peers = match manager.lock() {
        Ok(runtime) => {
            runtime.notes.save(runtime.storage_dir.as_ref());
            runtime.paired.keys().cloned().collect::<Vec<_>>()
        }
        Err(_) => return,
    };
    let manager = manager.clone();
    thread::spawn(move || {
        for peer in peers {
            let _ = peer::poke_notes(&manager, &peer);
        }
    });
}

// ---- The phone page (phone.rs) ----

/// Checklists (notes with tasks, locked ones left out), newest first, for the phone page.
pub fn phone_lists(manager: &BridgeLinkManager) -> Result<serde_json::Value, String> {
    let runtime = manager.lock()?;
    let mut notes: Vec<&Note> = runtime.notes.notes.values().filter(|n| !n.deleted && !n.blocks.iter().any(|b| !b.deleted && b.kind == "locked") && n.blocks.iter().any(|b| !b.deleted && b.kind == "todo")).collect();
    notes.sort_by(|a, b| b.updated().cmp(&a.updated()).then_with(|| a.title.cmp(&b.title)));
    let lists: Vec<serde_json::Value> = notes
        .into_iter()
        .take(30)
        .map(|n| {
            let items: Vec<serde_json::Value> = shown(n).into_iter().filter(|b| b.kind == "todo").take(200).map(|b| serde_json::json!({ "id": b.id, "text": b.text, "checked": b.checked, "indent": b.indent })).collect();
            serde_json::json!({ "id": n.id, "title": if n.title.trim().is_empty() { "Checklist" } else { n.title.as_str() }, "folder": n.folder, "items": items })
        })
        .collect();
    Ok(serde_json::Value::Array(lists))
}

/// Ticks a checklist item from the phone.
pub fn phone_check(manager: &BridgeLinkManager, note: &str, block: &str, checked: bool) -> Result<(), String> {
    local(manager, |store, device, now| {
        let current = store.notes.get(note).filter(|n| !n.deleted).ok_or("No such list")?;
        let item = current.blocks.iter().find(|b| b.id == block && !b.deleted && b.kind == "todo").ok_or("No such item")?.clone();
        store.apply(NotePatch { id: note.into(), blocks: vec![Block { checked, ..item }], ..Default::default() }, device, now).map(|_| ())
    })
}

/// Adds an item to the end of a checklist from the phone.
pub fn phone_add(manager: &BridgeLinkManager, note: &str, text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Nothing to add".into());
    }
    local(manager, |store, device, now| {
        let current = store.notes.get(note).filter(|n| !n.deleted).ok_or("No such list")?;
        let last = current.blocks.iter().filter(|b| !b.deleted).map(|b| b.pos.clone()).max().unwrap_or_default();
        let block = Block { id: Uuid::new_v4().to_string(), kind: "todo".into(), text: clean_text(text, MAX_TEXT), pos: format!("{last}V"), updated: now, by: device.into(), ..Default::default() };
        store.apply(NotePatch { id: note.into(), blocks: vec![block], ..Default::default() }, device, now).map(|_| ())
    })
}

/// Saves a conversation from the ChatGPT window as a note: the same chat (its address on the first
/// line) is updated where it is; a new one goes in `folder`.
pub fn save_chat(manager: &BridgeLinkManager, source: &str, title: &str, folder: &str, markdown: &str) -> Result<Note, String> {
    let first_line = format!("Saved from ChatGPT: {source}");
    let markdown = format!("{first_line}\n\n{markdown}");
    let (title, folder) = (title.to_string(), folder.to_string());
    local(manager, move |store, device, now| {
        let existing = store.list().into_iter().find(|n| !n.deleted && shown(n).first().is_some_and(|b| b.text == first_line));
        match existing {
            Some(note) => {
                let saved = store.replace_markdown(&note.id, &markdown, device, now)?;
                store.apply(NotePatch { id: saved.id.clone(), title: Some(title), ..Default::default() }, device, now)
            }
            None => store.create_from_markdown(None, "note", &title, &folder, &markdown, device, now),
        }
    })
}

/// All notes, for a backup (backups.rs).
pub fn all(manager: &BridgeLinkManager) -> Result<Vec<Note>, String> {
    Ok(manager.lock()?.notes.list())
}

/// Puts notes back from a backup. Returns how many.
pub fn restore_all(manager: &BridgeLinkManager, notes: Vec<Note>) -> Result<usize, String> {
    local(manager, |store, device, now| {
        let mut count = 0;
        for note in notes.into_iter().filter(|n| !n.deleted).filter_map(sanitize_note) {
            store.restore(note, device, now)?;
            count += 1;
        }
        Ok(count)
    })
}

pub(super) fn local<T>(manager: &BridgeLinkManager, change: impl FnOnce(&mut NoteStore, &str, u64) -> Result<T, String>) -> Result<T, String> {
    let value = {
        let mut runtime = manager.lock()?;
        let device = runtime.instance_id.clone();
        let mut notes = std::mem::take(&mut runtime.notes);
        let result = change(&mut notes, &device, now_ms());
        runtime.notes = notes;
        result?
    };
    changed(manager);
    Ok(value)
}

#[tauri::command]
pub fn notes_list(manager: State<'_, BridgeLinkManager>) -> Result<Vec<Note>, String> {
    Ok(manager.lock()?.notes.list())
}

#[tauri::command]
pub fn notes_create(kind: String, folder: String, manager: State<'_, BridgeLinkManager>) -> Result<Note, String> {
    local(&manager, |notes, device, now| notes.create(&kind, &folder, device, now))
}

#[tauri::command]
pub fn notes_save(app: AppHandle, patch: NotePatch, manager: State<'_, BridgeLinkManager>) -> Result<Note, String> {
    // The version it's leaving goes in its history (at most one every ten minutes).
    let before = manager.lock()?.notes.get(&patch.id).filter(|n| !n.deleted).cloned();
    if let Some(before) = before {
        crate::note_history::before_change(&app, &before, now_ms());
    }
    local(&manager, |notes, device, now| notes.apply(patch, device, now))
}

/// A note's content as Markdown (what gets encrypted when it's locked).
#[tauri::command]
pub fn notes_markdown(id: String, manager: State<'_, BridgeLinkManager>) -> Result<String, String> {
    manager.lock()?.notes.get(&id).filter(|n| !n.deleted).map(to_markdown).ok_or_else(|| "No such note".to_string())
}

/// Replaces a note's content with Markdown (a locked note unlocked for good).
#[tauri::command]
pub fn notes_replace_markdown(id: String, markdown: String, manager: State<'_, BridgeLinkManager>) -> Result<Note, String> {
    local(&manager, |notes, device, now| notes.replace_markdown(&id, &markdown, device, now))
}

/// Puts an earlier version of a note back (as a new edit, so it reaches the other computer too).
/// The version it replaces is kept first, so this can be undone the same way.
#[tauri::command]
pub fn note_version_restore(app: AppHandle, id: String, at: u64, manager: State<'_, BridgeLinkManager>) -> Result<Note, String> {
    let version = crate::note_history::version(&app, &id, at)?;
    let current = manager.lock()?.notes.get(&id).filter(|n| !n.deleted).cloned().ok_or("That note isn't here any more")?;
    crate::note_history::force_keep(&app, &current, now_ms());
    local(&manager, |notes, device, now| {
        let blocks = blocks_from_markdown(&version.markdown, "", device, now);
        notes.restore(Note { title: version.title.clone(), blocks, ..current.clone() }, device, now)
    })
}

/// A note made from Markdown (a book's chapter checklist, highlights).
#[tauri::command]
pub fn notes_create_markdown(title: String, folder: String, kind: String, markdown: String, manager: State<'_, BridgeLinkManager>) -> Result<Note, String> {
    local(&manager, |notes, device, now| notes.create_from_markdown(None, &kind, &title, &folder, &markdown, device, now))
}

#[tauri::command]
pub fn notes_delete(id: String, manager: State<'_, BridgeLinkManager>) -> Result<bool, String> {
    local(&manager, |notes, _, now| Ok(notes.delete(&id, now)))
}

// ---- Markdown, for Mimir (see `mimir_api.rs`) ----

/// The note's blocks in order, without deletion markers.
fn shown(note: &Note) -> Vec<&Block> {
    let mut blocks: Vec<&Block> = note.blocks.iter().filter(|b| !b.deleted).collect();
    blocks.sort_by(|a, b| a.pos.cmp(&b.pos).then_with(|| a.id.cmp(&b.id)));
    blocks
}

pub fn display_title(note: &Note) -> String {
    if !note.title.trim().is_empty() {
        return note.title.trim().to_string();
    }
    shown(note).iter().find(|b| !b.text.trim().is_empty()).map(|b| b.text.lines().next().unwrap_or("").chars().take(80).collect()).unwrap_or_else(|| "Untitled".into())
}

pub fn preview(note: &Note, max: usize) -> String {
    shown(note).iter().map(|b| b.text.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" · ").chars().take(max).collect()
}

fn due_text(ms: u64) -> String {
    // Kept as UTC so it reads the same on every computer; Mimir converts.
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60)
}

/// "2026-10-03T15:00Z" (as `due_text` writes it) back to ms.
fn parse_due(text: &str) -> Option<u64> {
    let t = text.trim().strip_suffix('Z')?;
    let (date, time) = t.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut hm = time.split(':').map(|p| p.parse::<i64>().ok());
    let (h, min) = (hm.next()??, hm.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || !(0..24).contains(&h) || !(0..60).contains(&min) {
        return None;
    }
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from((days * 86_400 + h * 3600 + min * 60) * 1000).ok()
}

/// A checklist item's text without a trailing "(due …)" tag, and the due time it gave.
fn split_due(text: &str) -> (String, Option<u64>) {
    if let Some(start) = text.rfind(" (due ") {
        if let Some(inner) = text[start + 6..].strip_suffix(')') {
            if let Some(due) = parse_due(inner) {
                return (text[..start].to_string(), Some(due));
            }
        }
    }
    (text.to_string(), None)
}

pub fn to_markdown(note: &Note) -> String {
    let mut out = String::new();
    let mut number = 0;
    let mut previous: Option<&str> = None;
    let listy = |kind: &str| matches!(kind, "li" | "ol" | "todo");
    for block in shown(note) {
        let pad = "  ".repeat(block.indent as usize);
        number = if block.kind == "ol" { number + 1 } else { 0 };
        let due = block.due.map(|d| format!(" (due {})", due_text(d))).unwrap_or_default();
        let line = match block.kind.as_str() {
            "h1" => format!("# {}", block.text),
            "h2" => format!("## {}", block.text),
            "h3" => format!("### {}", block.text),
            "li" => format!("{pad}- {}", block.text),
            "ol" => format!("{pad}{number}. {}", block.text),
            "todo" => format!("{pad}- [{}] {}{due}", if block.checked { "x" } else { " " }, block.text),
            "quote" => block.text.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n"),
            "code" => format!("```\n{}\n```", block.text),
            "graph" => format!("```graph\n{}\n```", block.text),
            "python" => format!("```python\n{}\n```", block.text),
            // A password-locked note's content, encrypted in the window (never the password).
            "locked" => format!("```bridgedeck-locked\n{}\n```", block.text),
            // The picture lives in the shared folder; this link brings the drawing back on import.
            "drawing" => format!("![Drawing](bridgedeck-drawing:{})", block.text),
            // Handwriting and pictures, kept in the shared folder like drawings.
            "ink" => format!("![Ink](bridgedeck-ink:{})", block.text),
            "image" => format!("![Image](bridgedeck-image:{})", block.text),
            _ => block.text.clone(),
        };
        // List items sit together; everything else is separated by a blank line, as Markdown
        // editors expect (two paragraphs on adjacent lines would read back as one).
        if let Some(prev) = previous {
            out.push_str(if listy(prev) && listy(&block.kind) { "\n" } else { "\n\n" });
        }
        out.push_str(&line);
        previous = Some(block.kind.as_str());
    }
    out
}

/// Blocks from Markdown: headings, bullet and numbered lists, checklists (`- [ ]`, nested by two
/// spaces), quotes, code fences and paragraphs. Positions continue after `after`.
pub fn blocks_from_markdown(markdown: &str, after: &str, device: &str, now: u64) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut paragraph: Vec<String> = Vec::new();
    let mut code: Option<Vec<String>> = None;
    // The fence's language: ```graph and ```python come back as those blocks.
    let mut fence = "code";
    let push = |blocks: &mut Vec<Block>, kind: &str, text: String, checked: bool, indent: u8| {
        let pos = format!("{after}{:05}V", blocks.len() + 1);
        blocks.push(Block { id: Uuid::new_v4().to_string(), kind: kind.into(), text: clean_text(&text, MAX_TEXT), checked, indent: indent.min(MAX_INDENT), pos, updated: now, by: device.into(), ..Default::default() });
    };
    let flush = |blocks: &mut Vec<Block>, paragraph: &mut Vec<String>| {
        if !paragraph.is_empty() {
            let text = paragraph.join("\n");
            paragraph.clear();
            let pos = format!("{after}{:05}V", blocks.len() + 1);
            blocks.push(Block { id: Uuid::new_v4().to_string(), kind: "p".into(), text: clean_text(&text, MAX_TEXT), pos, updated: now, by: device.into(), ..Default::default() });
        }
    };
    for raw in markdown.lines() {
        if let Some(lines) = code.as_mut() {
            if raw.trim_start().starts_with("```") {
                let text = lines.join("\n");
                code = None;
                push(&mut blocks, fence, text, false, 0);
            } else {
                lines.push(raw.to_string());
            }
            continue;
        }
        let spaces = raw.len() - raw.trim_start().len();
        let indent = (spaces / 2).min(MAX_INDENT as usize) as u8;
        let line = raw.trim();
        if let Some(lang) = line.strip_prefix("```") {
            flush(&mut blocks, &mut paragraph);
            fence = match lang.trim().to_ascii_lowercase().as_str() {
                "graph" => "graph",
                "python" | "py" | "python3" => "python",
                "bridgedeck-locked" => "locked",
                _ => "code",
            };
            code = Some(Vec::new());
            continue;
        }
        if line.is_empty() {
            flush(&mut blocks, &mut paragraph);
            continue;
        }
        let item = line.strip_prefix("- ").or_else(|| line.strip_prefix("* "));
        let checkbox = item.and_then(|rest| {
            let lower = rest.get(..3).map(|s| s.to_ascii_lowercase());
            match lower.as_deref() {
                Some("[ ]") => Some((false, rest[3..].trim().to_string())),
                Some("[x]") => Some((true, rest[3..].trim().to_string())),
                _ => None,
            }
        });
        let numbered = line.split_once(". ").filter(|(n, _)| !n.is_empty() && n.len() <= 3 && n.chars().all(|c| c.is_ascii_digit()));
        let kind_text: Option<(&str, String, bool)> = if let Some((checked, text)) = checkbox {
            Some(("todo", text, checked))
        } else if let Some(text) = item {
            Some(("li", text.to_string(), false))
        } else if let Some((_, text)) = numbered {
            Some(("ol", text.to_string(), false))
        } else if let Some(text) = line.strip_prefix("### ") {
            Some(("h3", text.to_string(), false))
        } else if let Some(text) = line.strip_prefix("## ") {
            Some(("h2", text.to_string(), false))
        } else if let Some(text) = line.strip_prefix("# ") {
            Some(("h1", text.to_string(), false))
        } else if let Some(id) = line.strip_prefix("![Drawing](bridgedeck-drawing:").and_then(|r| r.strip_suffix(')')).filter(|id| crate::drawings::valid_id(id)) {
            Some(("drawing", id.to_string(), false))
        } else if let Some(id) = line.strip_prefix("![Ink](bridgedeck-ink:").and_then(|r| r.strip_suffix(')')).filter(|id| crate::drawings::valid_id(id)) {
            Some(("ink", id.to_string(), false))
        } else if let Some(id) = line.strip_prefix("![Image](bridgedeck-image:").and_then(|r| r.strip_suffix(')')).filter(|id| crate::drawings::valid_id(id)) {
            Some(("image", id.to_string(), false))
        } else {
            line.strip_prefix("> ").map(|text| ("quote", text.to_string(), false))
        };
        match kind_text {
            Some((kind, text, checked)) => {
                flush(&mut blocks, &mut paragraph);
                let indent = if matches!(kind, "todo" | "li" | "ol") { indent } else { 0 };
                let (text, due) = if kind == "todo" { split_due(&text) } else { (text, None) };
                push(&mut blocks, kind, text, checked, indent);
                if let Some(last) = blocks.last_mut() {
                    last.due = due;
                }
            }
            None => paragraph.push(line.to_string()),
        }
    }
    if let Some(lines) = code {
        push(&mut blocks, "code", lines.join("\n"), false, 0);
    }
    flush(&mut blocks, &mut paragraph);
    blocks.truncate(MAX_BLOCKS);
    blocks
}

impl NoteStore {
    /// A new note from Markdown (Mimir). `id` is only used for Mimir's memory note.
    pub fn create_from_markdown(&mut self, id: Option<String>, kind: &str, title: &str, folder: &str, markdown: &str, device: &str, now: u64) -> Result<Note, String> {
        if self.notes.len() >= MAX_NOTES {
            return Err("There are too many notes; delete some first".into());
        }
        let id = match id {
            Some(id) if self.notes.get(&id).is_some_and(|n| !n.deleted) => return Err("That note already exists".into()),
            Some(id) => id,
            None => Uuid::new_v4().to_string(),
        };
        let mut blocks = blocks_from_markdown(markdown, "i", device, now);
        if blocks.is_empty() {
            blocks.push(Block { id: Uuid::new_v4().to_string(), kind: if kind == "list" { "todo" } else { "p" }.into(), pos: "i".into(), updated: now, by: device.into(), ..Default::default() });
        }
        let note = Note { id: id.clone(), title: clean_text(title, MAX_TITLE).replace(['\n', '\t'], " "), kind: if kind == "list" { "list" } else { "note" }.into(), folder: clean_text(folder, 80), created: now, title_updated: now, meta_updated: now, blocks, ..Default::default() };
        self.notes.insert(id.clone(), note);
        self.bump(&id);
        Ok(self.notes[&id].clone())
    }

    pub fn append_markdown(&mut self, id: &str, markdown: &str, device: &str, now: u64) -> Result<Note, String> {
        let note = self.notes.get(id).filter(|n| !n.deleted).ok_or("No such note")?;
        let last = note.blocks.iter().filter(|b| !b.deleted).map(|b| b.pos.clone()).max().unwrap_or_default();
        let blocks = blocks_from_markdown(markdown, &last, device, now);
        self.apply(NotePatch { id: id.into(), blocks, ..Default::default() }, device, now)
    }

    /// Replaces everything in a note with Markdown (Mimir's memory).
    pub fn replace_markdown(&mut self, id: &str, markdown: &str, device: &str, now: u64) -> Result<Note, String> {
        let note = self.notes.get(id).filter(|n| !n.deleted).ok_or("No such note")?;
        let removed = note.blocks.iter().filter(|b| !b.deleted).map(|b| b.id.clone()).collect();
        let blocks = blocks_from_markdown(markdown, &format!("r{now}"), device, now);
        self.apply(NotePatch { id: id.into(), blocks, removed, ..Default::default() }, device, now)
    }

    /// Ticks (or unticks) the checklist item whose text best matches `item`, with its sub-tasks.
    pub fn set_item(&mut self, id: &str, item: &str, done: bool, device: &str, now: u64) -> Result<usize, String> {
        let note = self.notes.get(id).filter(|n| !n.deleted).ok_or("No such note")?;
        let blocks: Vec<Block> = shown(note).into_iter().cloned().collect();
        let wanted = item.trim().to_lowercase();
        let index = blocks
            .iter()
            .position(|b| b.kind == "todo" && b.text.trim().to_lowercase() == wanted)
            .or_else(|| blocks.iter().position(|b| b.kind == "todo" && b.text.to_lowercase().contains(&wanted)))
            .ok_or_else(|| format!("No checklist item like “{item}” in that note"))?;
        let level = blocks[index].indent;
        let mut changed = vec![Block { checked: done, ..blocks[index].clone() }];
        for child in blocks[index + 1..].iter().take_while(|b| b.indent > level) {
            if child.kind == "todo" && child.checked != done {
                changed.push(Block { checked: done, ..child.clone() });
            }
        }
        let count = changed.len();
        self.apply(NotePatch { id: id.into(), blocks: changed, ..Default::default() }, device, now)?;
        Ok(count)
    }
}

/// A project's task board is a checklist note: each `##` heading is a column with its cards
/// (`- [ ]` items, sub-tasks indented) under it, the layout Obsidian's Kanban plugin uses.
pub const BOARD_COLUMNS: [&str; 3] = ["To do", "Doing", "Done"];

/// Cards in a column whose name says it's finished are ticked.
pub fn is_done_column(name: &str) -> bool {
    let name = name.to_lowercase();
    ["done", "complete", "finished", "shipped"].iter().any(|w| name.contains(w))
}

/// The board's columns in order: (heading block, its cards and their sub-tasks).
pub fn board_columns(note: &Note) -> Vec<(Option<Block>, Vec<Block>)> {
    let mut columns: Vec<(Option<Block>, Vec<Block>)> = Vec::new();
    for block in shown(note) {
        if matches!(block.kind.as_str(), "h1" | "h2" | "h3") {
            columns.push((Some(block.clone()), Vec::new()));
        } else if block.kind == "todo" {
            if columns.is_empty() {
                columns.push((None, Vec::new()));
            }
            columns.last_mut().unwrap().1.push(block.clone());
        }
    }
    columns
}

fn column_name(heading: &Option<Block>) -> String {
    heading.as_ref().map(|h| h.text.trim().to_string()).unwrap_or_else(|| BOARD_COLUMNS[0].into())
}

fn find_column(columns: &[(Option<Block>, Vec<Block>)], wanted: &str) -> Option<usize> {
    let wanted = wanted.trim().to_lowercase();
    columns
        .iter()
        .position(|(h, _)| column_name(h).to_lowercase() == wanted)
        .or_else(|| columns.iter().position(|(h, _)| column_name(h).to_lowercase().contains(&wanted)))
}

impl NoteStore {
    /// The last position in a column (its heading, or its last card or sub-task), leaving out `skip`.
    fn column_end(note: &Note, column: usize, skip: &[String]) -> String {
        let columns = board_columns(note);
        let (heading, cards) = &columns[column];
        cards.iter().filter(|b| !skip.contains(&b.id)).map(|b| b.pos.clone()).chain(heading.iter().map(|h| h.pos.clone())).max().unwrap_or_default()
    }

    /// Adds a card to a column of a board (the first column when none is named).
    pub fn board_add(&mut self, id: &str, column: Option<&str>, text: &str, due: Option<u64>, device: &str, now: u64) -> Result<Note, String> {
        let note = self.notes.get(id).filter(|n| !n.deleted).ok_or("No such board")?.clone();
        let columns = board_columns(&note);
        if columns.is_empty() {
            return Err("That note has no columns".into());
        }
        let index = match column {
            Some(name) if !name.trim().is_empty() => find_column(&columns, name).ok_or_else(|| format!("No column called “{name}”; the columns are {}", columns.iter().map(|(h, _)| column_name(h)).collect::<Vec<_>>().join(", ")))?,
            _ => 0,
        };
        let text = clean_text(text, MAX_TEXT).replace('\n', " ");
        if text.trim().is_empty() {
            return Err("The card needs text".into());
        }
        let after = Self::column_end(&note, index, &[]);
        let card = Block { id: Uuid::new_v4().to_string(), kind: "todo".into(), text, checked: is_done_column(&column_name(&columns[index].0)), due, pos: format!("{after}00001V"), updated: now, by: device.into(), ..Default::default() };
        self.apply(NotePatch { id: id.into(), blocks: vec![card], ..Default::default() }, device, now)
    }

    /// Moves the card best matching `item` (with its sub-tasks) to the end of a column.
    pub fn board_move(&mut self, id: &str, item: &str, column: &str, device: &str, now: u64) -> Result<Note, String> {
        let note = self.notes.get(id).filter(|n| !n.deleted).ok_or("No such board")?.clone();
        let columns = board_columns(&note);
        let target = find_column(&columns, column).ok_or_else(|| format!("No column called “{column}”"))?;
        let wanted = item.trim().to_lowercase();
        let cards: Vec<&Block> = columns.iter().flat_map(|(_, c)| c.iter()).filter(|b| b.indent == 0).collect();
        let card = cards
            .iter()
            .find(|b| b.text.trim().to_lowercase() == wanted)
            .or_else(|| cards.iter().find(|b| b.text.to_lowercase().contains(&wanted)))
            .ok_or_else(|| format!("No card like “{item}” on the board"))?;
        let all: Vec<&Block> = shown(&note);
        let start = all.iter().position(|b| b.id == card.id).unwrap_or(0);
        let moving: Vec<Block> = std::iter::once(all[start].clone()).chain(all[start + 1..].iter().take_while(|b| b.kind == "todo" && b.indent > 0).map(|b| (*b).clone())).collect();
        let skip: Vec<String> = moving.iter().map(|b| b.id.clone()).collect();
        let after = Self::column_end(&note, target, &skip);
        let done = is_done_column(&column_name(&columns[target].0));
        let moved: Vec<Block> = moving
            .into_iter()
            .enumerate()
            .map(|(i, b)| Block { pos: format!("{after}{:05}V", i + 1), checked: if i == 0 || done { done } else { b.checked }, ..b })
            .collect();
        self.apply(NotePatch { id: id.into(), blocks: moved, ..Default::default() }, device, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_chat_is_updated_in_place_when_saved_again() {
        let manager = BridgeLinkManager::default();
        manager.lock().unwrap().instance_id = "mac".into();
        let first = save_chat(&manager, "https://chatgpt.com/c/abc", "Chain rule (ChatGPT)", "Study/Math 221", "## You\n\nWhat is it?").unwrap();
        local(&manager, |store, device, now| store.apply(NotePatch { id: first.id.clone(), folder: Some("Study/Calc".into()), ..Default::default() }, device, now)).unwrap();
        let again = save_chat(&manager, "https://chatgpt.com/c/abc", "Chain rule, longer (ChatGPT)", "ChatGPT", "## You\n\nWhat is it?\n\n## ChatGPT\n\nf'(g(x))g'(x)").unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!((again.title.as_str(), again.folder.as_str()), ("Chain rule, longer (ChatGPT)", "Study/Calc"), "kept where the user moved it");
        assert_eq!(to_markdown(&again), "Saved from ChatGPT: https://chatgpt.com/c/abc\n\n## You\n\nWhat is it?\n\n## ChatGPT\n\nf'(g(x))g'(x)");
        let other = save_chat(&manager, "https://chatgpt.com/c/xyz", "Other", "ChatGPT", "hi").unwrap();
        assert_ne!(other.id, first.id);
    }

    #[test]
    fn a_board_note_keeps_cards_in_columns_and_moves_them_with_their_sub_tasks() {
        let mut store = NoteStore::default();
        let board = store.create_from_markdown(None, "list", "Robot — board", "Projects/Robot", "## To do\n\n- [ ] Order motors\n  - [ ] Check torque\n- [ ] CAD the chassis\n\n## Doing\n\n## Done", "mac", 1).unwrap();
        store.board_add(&board.id, Some("doing"), "Wire the ESC", None, "mac", 2).unwrap();
        store.board_add(&board.id, None, "Write the report", Some(5_000), "mac", 3).unwrap();
        assert!(store.board_add(&board.id, Some("Later"), "x", None, "mac", 3).unwrap_err().contains("To do, Doing, Done"));
        let note = store.board_move(&board.id, "order", "Done", "pc", 4).unwrap();
        assert_eq!(to_markdown(&note), "## To do\n\n- [ ] CAD the chassis\n- [ ] Write the report (due 1970-01-01T00:00Z)\n\n## Doing\n\n- [ ] Wire the ESC\n\n## Done\n\n- [x] Order motors\n  - [x] Check torque");
        // Back to Doing: unticked, the sub-task keeps its tick; then to the end of its own column.
        let note = store.board_move(&board.id, "Order motors", "doing", "pc", 5).unwrap();
        let columns = board_columns(&note);
        assert_eq!(columns[1].1.iter().map(|b| (b.text.as_str(), b.checked)).collect::<Vec<_>>(), vec![("Wire the ESC", false), ("Order motors", false), ("Check torque", true)]);
        let note = store.board_move(&board.id, "wire", "Doing", "pc", 6).unwrap();
        assert_eq!(board_columns(&note)[1].1.iter().map(|b| b.text.as_str()).collect::<Vec<_>>(), vec!["Order motors", "Check torque", "Wire the ESC"]);
    }

    #[test]
    fn a_backup_puts_notes_back_as_they_were_and_brings_deleted_ones_back_as_new() {
        let mut store = NoteStore::default();
        let note = store.create_from_markdown(None, "note", "Chain rule", "Study", "First\n\nSecond", "mac", 1).unwrap();
        let backup = note.clone();
        let first = shown(&note)[0].id.clone();
        // Since the backup: the first line edited, a line added, the title changed.
        let mut edited = shown(&note)[0].clone();
        edited.text = "Changed".into();
        let added = Block { id: "added".into(), kind: "p".into(), text: "New".into(), pos: "z".into(), ..Default::default() };
        store.apply(NotePatch { id: note.id.clone(), title: Some("Renamed".into()), blocks: vec![edited, added], ..Default::default() }, "pc", 2).unwrap();
        let back = store.restore(backup.clone(), "mac", 3).unwrap();
        assert_eq!(back.id, note.id);
        assert_eq!((back.title.as_str(), to_markdown(&back).as_str()), ("Chain rule", "First\n\nSecond"));
        assert!(back.blocks.iter().find(|b| b.id == first).is_some_and(|b| b.updated == 3), "restored lines are new edits, so they win on the other computer");
        // Deleted since the backup: it comes back under a new id.
        store.delete(&note.id, 4);
        let again = store.restore(backup, "mac", 5).unwrap();
        assert_ne!(again.id, note.id);
        assert_eq!((again.title.as_str(), again.folder.as_str(), to_markdown(&again).as_str()), ("Chain rule", "Study", "First\n\nSecond"));
    }

    fn block(id: &str, text: &str, updated: u64, by: &str) -> Block {
        Block { id: id.into(), kind: "p".into(), text: text.into(), pos: "i".into(), updated, by: by.into(), ..Default::default() }
    }

    #[test]
    fn editing_different_paragraphs_on_two_computers_keeps_both_edits() {
        let mut mac = NoteStore::default();
        let note = mac.create("note", "", "mac", 100).unwrap();
        let mut edited = note.clone();
        edited.blocks = vec![block(&note.blocks[0].id, "first", 0, ""), block("b2", "second", 0, "")];
        mac.save_from_ui(edited, "mac", 200).unwrap();

        let mut pc = NoteStore::default();
        for n in mac.changes_since(0).notes {
            pc.merge(n);
        }
        // Each computer edits a different paragraph.
        let mut on_mac = mac.list()[0].clone();
        on_mac.blocks.iter_mut().find(|b| b.id == note.blocks[0].id).unwrap().text = "first (mac)".into();
        mac.save_from_ui(on_mac, "mac", 300).unwrap();
        let mut on_pc = pc.list()[0].clone();
        on_pc.blocks.iter_mut().find(|b| b.id == "b2").unwrap().text = "second (pc)".into();
        pc.save_from_ui(on_pc, "pc", 310).unwrap();

        // Swap changes both ways.
        let from_mac = mac.changes_since(0).notes;
        let from_pc = pc.changes_since(0).notes;
        for n in from_mac {
            pc.merge(n);
        }
        for n in from_pc {
            mac.merge(n);
        }
        for store in [&mac, &pc] {
            let texts: Vec<String> = store.list()[0].blocks.iter().map(|b| b.text.clone()).collect();
            assert_eq!(texts, vec!["first (mac)", "second (pc)"]);
        }
    }

    #[test]
    fn the_newer_edit_of_the_same_paragraph_wins_everywhere() {
        let mut a = NoteStore::default();
        let note = a.create("note", "", "a", 1).unwrap();
        let mut b = NoteStore::default();
        b.merge(note.clone());
        let id = note.blocks[0].id.clone();
        let mut from_a = a.list()[0].clone();
        from_a.blocks[0].text = "older".into();
        a.save_from_ui(from_a, "a", 10).unwrap();
        let mut from_b = b.list()[0].clone();
        from_b.blocks[0].text = "newer".into();
        b.save_from_ui(from_b, "b", 20).unwrap();
        let (x, y) = (a.changes_since(0).notes, b.changes_since(0).notes);
        for n in y {
            a.merge(n);
        }
        for n in x {
            b.merge(n);
        }
        assert_eq!(a.list()[0].blocks.iter().find(|b| b.id == id).unwrap().text, "newer");
        assert_eq!(b.list()[0].blocks.iter().find(|b| b.id == id).unwrap().text, "newer");
    }

    #[test]
    fn deletions_spread_and_merging_twice_changes_nothing() {
        let mut a = NoteStore::default();
        let note = a.create("list", "Groceries", "a", 1).unwrap();
        let mut b = NoteStore::default();
        assert!(b.merge(note.clone()));
        assert!(!b.merge(note.clone()), "same note again is a no-op (no ping-pong)");
        assert!(a.delete(&note.id, 5));
        for n in a.changes_since(0).notes {
            b.merge(n);
        }
        assert!(b.list().is_empty());
        assert!(b.notes[&note.id].blocks.is_empty(), "deleted text doesn't linger");
    }

    #[test]
    fn pulls_come_in_pages_and_resume_where_they_stopped() {
        let mut a = NoteStore::default();
        for i in 0..30 {
            let note = a.create("note", "", "a", i).unwrap();
            let mut big = note.clone();
            big.blocks[0].text = "x".repeat(MAX_TEXT);
            big.blocks.extend((0..2).map(|j| block(&format!("b{i}x{j}"), &"y".repeat(MAX_TEXT), 0, "")));
            a.save_from_ui(big, "a", 100 + i).unwrap();
        }
        let mut b = NoteStore::default();
        let mut since = 0;
        let mut pages = 0;
        loop {
            let answer = a.changes_since(since);
            pages += 1;
            for n in answer.notes {
                b.merge(n);
            }
            since = answer.upto;
            if !answer.more {
                break;
            }
        }
        assert!(pages > 1);
        assert_eq!(b.list().len(), 30);
        assert!(a.changes_since(since).notes.is_empty());
    }

    #[test]
    fn mimir_mark_is_kept_and_spreads() {
        let mut store = NoteStore::default();
        let note = store.create_from_markdown(None, "note", "Plan", "", "hi", "pc", 1).unwrap();
        let marked = store.apply(NotePatch { id: note.id.clone(), mimir: Some(true), ..Default::default() }, "pc", 2).unwrap();
        assert!(marked.mimir);
        // Editing the text leaves the mark alone.
        let edited = store.apply(NotePatch { id: note.id.clone(), title: Some("Plan 2".into()), ..Default::default() }, "pc", 3).unwrap();
        assert!(edited.mimir);
        let mut other = NoteStore::default();
        other.merge(edited);
        assert!(other.notes[&note.id].mimir);
    }

    #[test]
    fn a_patch_only_touches_what_it_names() {
        let mut store = NoteStore::default();
        let note = store.create("note", "", "mac", 100).unwrap();
        let first = note.blocks[0].id.clone();
        // Another computer's paragraph arrives while this one is editing an older copy.
        let mut remote = store.list()[0].clone();
        remote.blocks.push(block("from-pc", "added on the PC", 150, "pc"));
        remote.blocks[0].updated = 150;
        remote.blocks[0].text = "pc".into();
        remote.blocks[0].by = "pc".into();
        store.merge(remote);
        let patch = NotePatch { id: note.id.clone(), title: Some("Groceries".into()), ..Default::default() };
        let saved = store.apply(patch, "mac", 200).unwrap();
        assert_eq!(saved.title, "Groceries");
        assert!(saved.blocks.iter().any(|b| b.id == "from-pc" && !b.deleted));
        assert_eq!(saved.blocks.iter().find(|b| b.id == first).unwrap().text, "pc");
        let removed = store.apply(NotePatch { id: note.id.clone(), removed: vec!["from-pc".into()], ..Default::default() }, "mac", 300).unwrap();
        assert!(removed.blocks.iter().find(|b| b.id == "from-pc").unwrap().deleted);
    }

    #[test]
    fn sub_tasks_keep_their_nesting_and_it_is_capped() {
        let mut store = NoteStore::default();
        let note = store.create("list", "", "mac", 100).unwrap();
        let sub = Block { id: "s1".into(), kind: "todo".into(), text: "Ch 11.1".into(), indent: 1, pos: "m".into(), ..Default::default() };
        let deep = Block { id: "s2".into(), kind: "todo".into(), text: "too deep".into(), indent: 9, pos: "n".into(), ..Default::default() };
        let saved = store.apply(NotePatch { id: note.id.clone(), blocks: vec![sub.clone(), deep], ..Default::default() }, "mac", 200).unwrap();
        let find = |id: &str| saved.blocks.iter().find(|b| b.id == id).unwrap().indent;
        assert_eq!((find("s1"), find("s2")), (1, MAX_INDENT));
        // Moving it back out is a change like any other.
        let out = store.apply(NotePatch { id: note.id.clone(), blocks: vec![Block { indent: 0, ..sub }], ..Default::default() }, "mac", 300).unwrap();
        assert_eq!(out.blocks.iter().find(|b| b.id == "s1").unwrap().indent, 0);
    }

    #[test]
    fn block_kinds_from_a_newer_build_are_kept() {
        let mut store = NoteStore::default();
        let note = store.create_from_markdown(None, "note", "Future", "", "Text", "mac", 100).unwrap();
        let block = |id: &str, kind: &str| Block { id: id.into(), kind: kind.into(), text: "x".into(), pos: id.into(), updated: 200, by: "pc".into(), ..Default::default() };
        let incoming = Note { blocks: vec![block("a", "calc"), block("b", "table-2"), block("c", "Bad Kind!"), block("d", "ink"), block("e", "")], title_updated: 0, ..note.clone() };
        store.merge(incoming);
        let kinds: Vec<(String, String)> = store.notes[&note.id].blocks.iter().map(|b| (b.id.clone(), b.kind.clone())).filter(|(id, _)| id.len() == 1).collect();
        assert_eq!(kinds, vec![("a".into(), "calc".into()), ("b".into(), "table-2".into()), ("c".into(), "p".into()), ("d".into(), "ink".into()), ("e".into(), "p".into())]);
    }

    #[test]
    fn ink_and_images_go_out_to_markdown_and_come_back() {
        let mut store = NoteStore::default();
        let note = store.create_from_markdown(None, "note", "Scan", "", "![Ink](bridgedeck-ink:pen_1)\n\n![Image](bridgedeck-image:img_2)\n\n![Ink](bridgedeck-ink:../x)", "mac", 100).unwrap();
        let kinds: Vec<(&str, &str)> = shown(&note).iter().map(|b| (b.kind.as_str(), b.text.as_str())).collect();
        assert_eq!(kinds, vec![("ink", "pen_1"), ("image", "img_2"), ("p", "![Ink](bridgedeck-ink:../x)")]);
        let md = to_markdown(&note);
        assert!(md.contains("![Ink](bridgedeck-ink:pen_1)") && md.contains("![Image](bridgedeck-image:img_2)"));
    }

    #[test]
    fn drawings_go_out_to_markdown_and_come_back() {
        let mut store = NoteStore::default();
        let note = store.create_from_markdown(None, "note", "Sketch", "", "Before\n\n![Drawing](bridgedeck-drawing:abc_12)\n\n![Drawing](bridgedeck-drawing:../x)", "mac", 100).unwrap();
        let kinds: Vec<(&str, &str)> = shown(&note).iter().map(|b| (b.kind.as_str(), b.text.as_str())).collect();
        assert_eq!(kinds, vec![("p", "Before"), ("drawing", "abc_12"), ("p", "![Drawing](bridgedeck-drawing:../x)")]);
        assert!(to_markdown(&note).contains("![Drawing](bridgedeck-drawing:abc_12)"));
    }

    #[test]
    fn graph_and_python_blocks_are_fenced() {
        let mut store = NoteStore::default();
        let md = "```graph\ny = sin(x)\nx: -5..5\n```\n\n```py\nprint(1)\n```\n\n```rust\nfn x() {}\n```";
        let note = store.create_from_markdown(None, "note", "Lab", "", md, "mac", 100).unwrap();
        let kinds: Vec<(&str, &str)> = shown(&note).iter().map(|b| (b.kind.as_str(), b.text.as_str())).collect();
        assert_eq!(kinds, vec![("graph", "y = sin(x)\nx: -5..5"), ("python", "print(1)"), ("code", "fn x() {}")]);
        let out = to_markdown(&note);
        assert!(out.starts_with("```graph\ny = sin(x)\nx: -5..5\n```\n\n```python\nprint(1)\n```"));
    }

    #[test]
    fn markdown_goes_in_and_out_with_checklists_and_sub_tasks() {
        let mut store = NoteStore::default();
        let md = "# Book\n\nRead slowly.\nTake notes.\n\n- [ ] Ch 11\n  - [x] Ch 11.1\n  - [ ] Ch 11.2\n- point\n1. first\n> quoted\n```\nlet x = 1;\n```";
        let note = store.create_from_markdown(None, "list", "Study", "School", md, "mac", 100).unwrap();
        let kinds: Vec<(&str, u8)> = shown(&note).iter().map(|b| (b.kind.as_str(), b.indent)).collect();
        assert_eq!(kinds, vec![("h1", 0), ("p", 0), ("todo", 0), ("todo", 1), ("todo", 1), ("li", 0), ("ol", 0), ("quote", 0), ("code", 0)]);
        assert_eq!(to_markdown(&note), "# Book\n\nRead slowly.\nTake notes.\n\n- [ ] Ch 11\n  - [x] Ch 11.1\n  - [ ] Ch 11.2\n- point\n1. first\n\n> quoted\n\n```\nlet x = 1;\n```");
        // Reading its own Markdown back gives the same blocks.
        let again = store.create_from_markdown(None, "note", "", "", &to_markdown(&note), "mac", 150).unwrap();
        assert_eq!(to_markdown(&again), to_markdown(&note));
        // Ticking a task by name ticks its sub-tasks too.
        assert_eq!(store.set_item(&note.id, "ch 11", true, "mac", 200).unwrap(), 2);
        let after = store.list()[0].clone();
        assert!(shown(&after).iter().filter(|b| b.kind == "todo").all(|b| b.checked));
        // Appending keeps the order; replacing swaps everything.
        let appended = store.append_markdown(&note.id, "- [ ] Ch 12", "mac", 300).unwrap();
        assert_eq!(shown(&appended).last().unwrap().text, "Ch 12");
        let replaced = store.replace_markdown(&note.id, "Only this", "mac", 400).unwrap();
        assert_eq!(to_markdown(&replaced), "Only this");
        assert!(store.create_from_markdown(Some(note.id.clone()), "note", "", "", "", "mac", 500).is_err());
        // Due times survive the trip.
        let due = store.append_markdown(&note.id, "- [ ] Submit (due 2026-10-03T15:00Z)", "mac", 600).unwrap();
        let item = shown(&due).into_iter().find(|b| b.text == "Submit").unwrap().clone();
        assert_eq!(item.due, Some(1_791_039_600_000));
        assert!(to_markdown(&due).ends_with("- [ ] Submit (due 2026-10-03T15:00Z)"));
    }

    #[test]
    fn untrusted_notes_are_cleaned() {
        let mut store = NoteStore::default();
        let hostile = Note { id: "../../etc".into(), title: "a\nb".into(), kind: "exec".into(), blocks: vec![Block { id: "x".into(), kind: "<script>".into(), text: "\u{0007}hi".into(), ..Default::default() }], ..Default::default() };
        assert!(store.merge(hostile));
        let note = store.list().into_iter().next().unwrap();
        assert_eq!(note.id, "etc");
        assert_eq!(note.title, "a b");
        assert_eq!(note.kind, "note");
        assert_eq!(note.blocks[0].kind, "p");
        assert_eq!(note.blocks[0].text, "hi");
    }
}
