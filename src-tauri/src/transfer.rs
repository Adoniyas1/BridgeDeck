//! Files between paired computers over the encrypted BridgeLink connection (LAN or Tailscale), with
//! progress, cancel and resume. LocalSend stays for other devices (phones, other people).
//!
//! The sender opens a stream (`PATH`) whose first request carries an offer: the files' relative
//! paths, sizes and change times. The receiver answers with how much of each file it already has
//! (from an earlier, interrupted try of the same transfer), then the sender streams the rest as raw
//! chunks, file after file. Partial files live in this app's data folder; when everything has
//! arrived they move into the receive folder (never overwriting: "name (1).ext").
//! Only paired computers can send (the caller's certificate is checked before anything is read).

use crate::bridgelink::BridgeLinkManager;
use crate::link::transport::{read_frame, read_raw, write_frame, write_raw, Request};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub const PATH: &str = "/files/send";
const CHUNK: usize = 1024 * 1024;
const MAX_FILES: usize = 5_000;
/// Interrupted transfers a computer keeps around to resume, before they are thrown away.
const KEEP_PARTIAL: Duration = Duration::from_secs(7 * 86_400);
const RETRIES: [u64; 3] = [2, 5, 15];
/// What a send to a BridgeDeck too old to receive this way fails with (the UI falls back to LocalSend).
pub const OLD_PEER: &str = "The other computer needs a newer BridgeDeck to receive files this way";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfferFile {
    /// Path under the transfer, with `/` between folders.
    pub rel: String,
    pub size: u64,
    /// Last change, ms since 1970 (a changed file starts over instead of resuming).
    pub modified: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub id: String,
    pub files: Vec<OfferFile>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Reply {
    /// Bytes of each file already here; the sender continues from there.
    Accept { offsets: Vec<u64> },
    Refuse { reason: String },
    Done { folder: String },
    Failed { reason: String },
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatus {
    pub id: String,
    /// "send" or "receive".
    pub direction: String,
    pub peer_id: String,
    pub peer_name: String,
    pub files: usize,
    /// The first few names, for showing.
    pub names: Vec<String>,
    pub total_bytes: u64,
    pub done_bytes: u64,
    /// connecting, sending, receiving, retrying, done, failed, cancelled
    pub state: String,
    pub error: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    /// Where received files were saved.
    pub folder: Option<String>,
    /// Bytes per second, smoothed.
    pub rate: f64,
    pub can_resume: bool,
}

struct Entry {
    status: TransferStatus,
    cancel: Arc<AtomicBool>,
    /// Sender: the files, for resuming.
    sources: Vec<(PathBuf, String)>,
    rate_mark: (Instant, u64),
}

static TRANSFERS: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn changed() {
    if let Some(app) = APP.get() {
        let _ = app.emit("transfers-changed", ());
    }
}

fn with_entry<T>(key: &str, f: impl FnOnce(&mut Entry) -> T) -> Option<T> {
    let mut all = TRANSFERS.lock().ok()?;
    all.get_or_insert_with(HashMap::new).get_mut(key).map(f)
}

fn insert(key: String, entry: Entry) {
    if let Ok(mut all) = TRANSFERS.lock() {
        let all = all.get_or_insert_with(HashMap::new);
        // Keep the list short: drop the oldest finished ones.
        if all.len() > 60 {
            let mut finished: Vec<(String, u64)> = all.iter().filter(|(_, e)| e.status.finished_at.is_some()).map(|(k, e)| (k.clone(), e.status.started_at)).collect();
            finished.sort_by_key(|(_, t)| *t);
            for (k, _) in finished.into_iter().take(20) {
                all.remove(&k);
            }
        }
        all.insert(key, entry);
    }
    changed();
}

fn set_state(key: &str, state: &str, error: Option<String>) {
    with_entry(key, |e| {
        e.status.state = state.into();
        e.status.error = error;
        let finished = matches!(state, "done" | "failed" | "cancelled");
        e.status.finished_at = finished.then(now_ms);
        e.status.can_resume = e.status.direction == "send" && matches!(state, "failed" | "cancelled");
        if finished {
            e.status.rate = 0.0;
        }
    });
    changed();
}

fn progress(key: &str, done: u64) {
    with_entry(key, |e| {
        e.status.done_bytes = done;
        let (at, bytes) = e.rate_mark;
        let elapsed = at.elapsed().as_secs_f64();
        if elapsed >= 0.5 {
            let rate = done.saturating_sub(bytes) as f64 / elapsed;
            e.status.rate = if e.status.rate == 0.0 { rate } else { e.status.rate * 0.6 + rate * 0.4 };
            e.rate_mark = (Instant::now(), done);
        }
    });
}

fn cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Relaxed)
}

// ---- Sending ----

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Files under the picked paths, with paths relative to each pick's parent (a folder keeps its
/// name and layout). Symbolic links are skipped.
pub fn expand(paths: &[PathBuf]) -> Result<Vec<(PathBuf, String)>, String> {
    let mut out = Vec::new();
    for path in paths {
        let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or_else(|| format!("{} has no name", path.display()))?;
        if meta.is_file() {
            out.push((path.clone(), name));
        } else if meta.is_dir() {
            let mut stack = vec![(path.clone(), name)];
            while let Some((dir, rel)) = stack.pop() {
                let mut entries: Vec<_> = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?.filter_map(Result::ok).collect();
                entries.sort_by_key(|e| e.file_name());
                for entry in entries {
                    let Ok(kind) = entry.file_type() else { continue };
                    let child = format!("{rel}/{}", entry.file_name().to_string_lossy());
                    if kind.is_dir() {
                        stack.push((entry.path(), child));
                    } else if kind.is_file() {
                        out.push((entry.path(), child));
                    }
                }
                if out.len() > MAX_FILES {
                    return Err(format!("That's more than {MAX_FILES} files; zip the folder and send the zip"));
                }
            }
        }
    }
    if out.is_empty() {
        return Err("There are no files to send".into());
    }
    Ok(out)
}

fn offer_for(id: &str, sources: &[(PathBuf, String)]) -> Result<Offer, String> {
    let mut files = Vec::with_capacity(sources.len());
    for (path, rel) in sources {
        let meta = std::fs::metadata(path).map_err(|e| format!("{rel}: {e}"))?;
        files.push(OfferFile { rel: rel.clone(), size: meta.len(), modified: modified_ms(&meta) });
    }
    Ok(Offer { id: id.into(), files })
}

/// Starts sending (or resumes, with the same id) and returns at once; progress is in the list.
pub fn start_send(manager: BridgeLinkManager, peer_id: String, sources: Vec<(PathBuf, String)>, id: Option<String>) -> Result<String, String> {
    let peer_name = crate::bridgelink::peer::paired_peers(&manager).into_iter().find(|(id, _)| id == &peer_id).map(|(_, name)| name).ok_or("Paired computer not found")?;
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let key = format!("send:{id}");
    let cancel = Arc::new(AtomicBool::new(false));
    let total: u64 = sources.iter().filter_map(|(p, _)| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
    insert(key.clone(), Entry {
        status: TransferStatus {
            id: id.clone(),
            direction: "send".into(),
            peer_id: peer_id.clone(),
            peer_name,
            files: sources.len(),
            names: sources.iter().take(5).map(|(_, r)| r.clone()).collect(),
            total_bytes: total,
            done_bytes: 0,
            state: "connecting".into(),
            error: None,
            started_at: now_ms(),
            finished_at: None,
            folder: None,
            rate: 0.0,
            can_resume: false,
        },
        cancel: cancel.clone(),
        sources: sources.clone(),
        rate_mark: (Instant::now(), 0),
    });
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut attempt = 0;
        loop {
            match send_once(&manager, &peer_id, &task_id, &sources, &cancel).await {
                Ok(()) => return set_state(&key, "done", None),
                Err(_) if cancelled(&cancel) => return set_state(&key, "cancelled", None),
                Err(SendError::Final(reason)) => return set_state(&key, "failed", Some(reason)),
                Err(SendError::Retry(reason)) => {
                    let Some(wait) = RETRIES.get(attempt) else { return set_state(&key, "failed", Some(reason)) };
                    attempt += 1;
                    set_state(&key, "retrying", Some(reason));
                    for _ in 0..(*wait * 10) {
                        if cancelled(&cancel) {
                            return set_state(&key, "cancelled", None);
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        }
    });
    Ok(id)
}

enum SendError {
    /// The connection dropped or timed out: worth trying again (it resumes).
    Retry(String),
    /// Refused, a file problem, or the other side failed: trying again won't help.
    Final(String),
}

async fn send_once(manager: &BridgeLinkManager, peer_id: &str, id: &str, sources: &[(PathBuf, String)], cancel: &AtomicBool) -> Result<(), SendError> {
    let key = format!("send:{id}");
    let offer = offer_for(id, sources).map_err(SendError::Final)?;
    let total: u64 = offer.files.iter().map(|f| f.size).sum();
    with_entry(&key, |e| e.status.total_bytes = total);
    set_state(&key, "connecting", None);
    let (link, addresses, fingerprint) = crate::bridgelink::peer::link_to(manager, peer_id).map_err(SendError::Final)?;
    let body = serde_json::to_string(&offer).map_err(|e| SendError::Final(e.to_string()))?;
    if body.len() > crate::link::transport::MAX_FRAME - 1024 {
        return Err(SendError::Final("Too many files at once; zip them and send the zip".into()));
    }
    let request = Request { method: "POST".into(), path: PATH.into(), body };
    let (mut send, mut recv) = link.open_stream(&addresses, &fingerprint, &request).await.map_err(SendError::Retry)?;
    let first = tokio::time::timeout(Duration::from_secs(60), read_frame::<serde_json::Value>(&mut recv))
        .await
        .map_err(|_| SendError::Retry("The other computer didn't answer".into()))?
        .map_err(|e| SendError::Retry(format!("The connection dropped: {e}")))?;
    // A BridgeDeck from before this existed answers as if it were an ordinary request.
    if first.get("type").is_none() && first.get("status").is_some() {
        return Err(SendError::Final(OLD_PEER.into()));
    }
    let reply: Reply = serde_json::from_value(first).map_err(|_| SendError::Final("Unexpected answer from the other computer".into()))?;
    let offsets = match reply {
        Reply::Accept { offsets } if offsets.len() == offer.files.len() => offsets,
        Reply::Refuse { reason } | Reply::Failed { reason } => return Err(SendError::Final(reason)),
        _ => return Err(SendError::Final("Unexpected answer from the other computer".into())),
    };
    let mut done: u64 = offsets.iter().zip(&offer.files).map(|(o, f)| (*o).min(f.size)).sum();
    progress(&key, done);
    set_state(&key, "sending", None);
    let mut buffer = vec![0u8; CHUNK];
    for ((path, _), (file, offset)) in sources.iter().zip(offer.files.iter().zip(&offsets)) {
        if *offset >= file.size {
            continue;
        }
        let mut input = tokio::fs::File::open(path).await.map_err(|e| SendError::Final(format!("{}: {e}", file.rel)))?;
        input.seek(std::io::SeekFrom::Start(*offset)).await.map_err(|e| SendError::Final(format!("{}: {e}", file.rel)))?;
        let mut left = file.size - offset;
        while left > 0 {
            if cancelled(cancel) {
                let _ = send.reset(1u32.into());
                return Err(SendError::Final("Cancelled".into()));
            }
            let want = (left as usize).min(CHUNK);
            let read = input.read(&mut buffer[..want]).await.map_err(|e| SendError::Final(format!("{}: {e}", file.rel)))?;
            if read == 0 {
                let _ = send.reset(2u32.into());
                return Err(SendError::Final(format!("{} got shorter while sending; send it again", file.rel)));
            }
            if let Err(error) = write_raw(&mut send, &buffer[..read]).await {
                // The receiver may have said why it stopped.
                if let Ok(Ok(Reply::Failed { reason } | Reply::Refuse { reason })) = tokio::time::timeout(Duration::from_secs(2), read_frame::<Reply>(&mut recv)).await {
                    return Err(SendError::Final(reason));
                }
                return Err(SendError::Retry(format!("The connection dropped: {error}")));
            }
            left -= read as u64;
            done += read as u64;
            progress(&key, done);
        }
    }
    let _ = send.finish();
    match tokio::time::timeout(Duration::from_secs(120), read_frame::<Reply>(&mut recv)).await {
        Ok(Ok(Reply::Done { .. })) => Ok(()),
        Ok(Ok(Reply::Failed { reason } | Reply::Refuse { reason })) => Err(SendError::Final(reason)),
        Ok(Ok(_)) => Err(SendError::Final("Unexpected answer from the other computer".into())),
        Ok(Err(error)) => Err(SendError::Retry(format!("The connection dropped: {error}"))),
        Err(_) => Err(SendError::Retry("The other computer didn't confirm".into())),
    }
}

// ---- Receiving ----

/// One path component made safe on every system: no separators, reserved names or characters
/// Windows can't store.
fn clean_component(part: &str) -> String {
    let mut name: String = part.chars().map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/') { '_' } else { c }).collect();
    name = name.trim_end_matches(['.', ' ']).trim_start().to_string();
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        name.insert(0, '_');
    }
    name.chars().take(200).collect()
}

/// A relative path from the other computer, or None if it tries to leave the receive folder.
pub fn safe_rel(rel: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in rel.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        let clean = clean_component(part);
        if clean.is_empty() {
            return None;
        }
        out.push(clean);
    }
    let ok = !out.as_os_str().is_empty() && out.components().all(|c| matches!(c, Component::Normal(_)));
    ok.then_some(out)
}

/// A free name for `rel` under `dest`: "name.ext", else "name (1).ext", …
fn free_target(dest: &Path, rel: &Path) -> PathBuf {
    let candidate = dest.join(rel);
    if !candidate.exists() {
        return candidate;
    }
    let parent = candidate.parent().map(Path::to_path_buf).unwrap_or_else(|| dest.to_path_buf());
    let stem = candidate.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let ext = candidate.extension().map(|s| s.to_string_lossy().to_string());
    for n in 1..10_000u32 {
        let next = parent.join(match &ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        });
        if !next.exists() {
            return next;
        }
    }
    parent.join(format!("{stem} ({})", uuid::Uuid::new_v4()))
}

/// Moves a finished file into place; across drives it is copied.
fn move_into_place(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

/// Where received files go, and where partial files wait.
pub struct ReceiveDirs {
    pub dest: PathBuf,
    pub partial: PathBuf,
}

pub fn receive_dirs(app: Option<&AppHandle>) -> Result<ReceiveDirs, String> {
    #[cfg(test)]
    if let Some(dirs) = TEST_DIRS.lock().ok().and_then(|d| d.as_ref().map(|(a, b)| ReceiveDirs { dest: a.clone(), partial: b.clone() })) {
        return Ok(dirs);
    }
    let app = app.ok_or("BridgeDeck isn't ready to receive yet")?;
    let partial = app.path().app_data_dir().map_err(|e| e.to_string())?.join("incoming");
    Ok(ReceiveDirs { dest: crate::localsend_bridge::receive_destination(app), partial })
}

#[cfg(test)]
pub static TEST_DIRS: Mutex<Option<(PathBuf, PathBuf)>> = Mutex::new(None);

fn clean_old_partials(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.filter_map(Result::ok) {
        let old = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > KEEP_PARTIAL);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Serves a paired computer's transfer (the caller was checked by the stream handler).
pub async fn serve(dirs: Result<ReceiveDirs, String>, local_name: String, peer_id: String, peer_name: String, body: String, mut send: quinn::SendStream, mut recv: quinn::RecvStream) {
    let refuse = |reason: String| Reply::Refuse { reason };
    let offer = match serde_json::from_str::<Offer>(&body) {
        Ok(offer) => offer,
        Err(_) => {
            let _ = write_frame(&mut send, &refuse("Invalid transfer".into())).await;
            let _ = send.finish();
            return;
        }
    };
    let id: String = offer.id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    let rels: Option<Vec<PathBuf>> = offer.files.iter().map(|f| safe_rel(&f.rel)).collect();
    let (dirs, rels) = match (dirs, rels) {
        (Ok(dirs), Some(rels)) if !id.is_empty() && !rels.is_empty() && rels.len() <= MAX_FILES => (dirs, rels),
        (Err(reason), _) => {
            let _ = write_frame(&mut send, &refuse(reason)).await;
            let _ = send.finish();
            return;
        }
        _ => {
            let _ = write_frame(&mut send, &refuse("The file list isn't safe to save".into())).await;
            let _ = send.finish();
            return;
        }
    };
    let key = format!("receive:{id}");
    let cancel = Arc::new(AtomicBool::new(false));
    let total: u64 = offer.files.iter().map(|f| f.size).sum();
    insert(key.clone(), Entry {
        status: TransferStatus {
            id: id.clone(),
            direction: "receive".into(),
            peer_id,
            peer_name: peer_name.clone(),
            files: offer.files.len(),
            names: offer.files.iter().take(5).map(|f| f.rel.clone()).collect(),
            total_bytes: total,
            done_bytes: 0,
            state: "receiving".into(),
            error: None,
            started_at: now_ms(),
            finished_at: None,
            folder: Some(dirs.dest.to_string_lossy().to_string()),
            rate: 0.0,
            can_resume: false,
        },
        cancel: cancel.clone(),
        sources: Vec::new(),
        rate_mark: (Instant::now(), 0),
    });
    let result = receive(&dirs, &id, &offer, &rels, &key, &cancel, &mut send, &mut recv).await;
    match result {
        Ok(()) => {
            let _ = write_frame(&mut send, &Reply::Done { folder: dirs.dest.to_string_lossy().to_string() }).await;
            let _ = send.finish();
            set_state(&key, "done", None);
        }
        Err(reason) => {
            let _ = recv.stop(1u32.into());
            let was_cancelled = cancelled(&cancel);
            let reason = if was_cancelled { format!("Cancelled on {local_name}") } else { reason };
            let _ = write_frame(&mut send, &Reply::Failed { reason: reason.clone() }).await;
            let _ = send.finish();
            if was_cancelled {
                set_state(&key, "cancelled", None);
            } else {
                set_state(&key, "failed", Some(reason));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn receive(dirs: &ReceiveDirs, id: &str, offer: &Offer, rels: &[PathBuf], key: &str, cancel: &AtomicBool, send: &mut quinn::SendStream, recv: &mut quinn::RecvStream) -> Result<(), String> {
    clean_old_partials(&dirs.partial);
    let folder = dirs.partial.join(id);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Can't save here: {e}"))?;
    // What an earlier try of this transfer left, per file; a file that changed starts over.
    let meta_path = folder.join("offer.json");
    let before: Vec<OfferFile> = std::fs::read_to_string(&meta_path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
    std::fs::write(&meta_path, serde_json::to_string(&offer.files).unwrap_or_default()).map_err(|e| format!("Can't save here: {e}"))?;
    let parts: Vec<PathBuf> = (0..offer.files.len()).map(|i| folder.join(format!("{i}.part"))).collect();
    let mut offsets = Vec::with_capacity(offer.files.len());
    for (i, file) in offer.files.iter().enumerate() {
        let same = before.get(i).is_some_and(|b| b == file);
        let have = if same { std::fs::metadata(&parts[i]).map(|m| m.len()).unwrap_or(0) } else { 0 };
        if !same || have > file.size {
            let _ = std::fs::remove_file(&parts[i]);
            offsets.push(0);
        } else {
            offsets.push(have);
        }
    }
    let mut done: u64 = offsets.iter().sum();
    progress(key, done);
    write_frame(send, &Reply::Accept { offsets: offsets.clone() }).await?;

    for (i, file) in offer.files.iter().enumerate() {
        let mut have = offsets[i];
        let mut output = tokio::fs::OpenOptions::new().create(true).append(true).open(&parts[i]).await.map_err(|e| format!("Can't save {}: {e}", file.rel))?;
        while have < file.size {
            if cancelled(cancel) {
                return Err("Cancelled".into());
            }
            let chunk = tokio::time::timeout(Duration::from_secs(60), read_raw(recv))
                .await
                .map_err(|_| "The other computer stopped sending".to_string())?
                .map_err(|e| format!("The connection dropped: {e}"))?;
            if chunk.is_empty() || have + chunk.len() as u64 > file.size {
                return Err("The other computer sent more than it offered".into());
            }
            output.write_all(&chunk).await.map_err(|e| format!("Can't save {}: {e}", file.rel))?;
            have += chunk.len() as u64;
            done += chunk.len() as u64;
            progress(key, done);
        }
        output.flush().await.map_err(|e| format!("Can't save {}: {e}", file.rel))?;
    }

    // Everything arrived: into the receive folder, never over an existing file.
    for (i, rel) in rels.iter().enumerate() {
        let target = free_target(&dirs.dest, rel);
        // An empty file has no partial yet.
        if !parts[i].exists() {
            std::fs::File::create(&parts[i]).map_err(|e| e.to_string())?;
        }
        move_into_place(&parts[i], &target).map_err(|e| format!("Can't save {}: {e}", rel.display()))?;
    }
    let _ = std::fs::remove_dir_all(&folder);
    Ok(())
}

// ---- Commands ----

#[tauri::command]
pub fn transfer_send(peer: String, paths: Vec<String>, manager: State<'_, BridgeLinkManager>) -> Result<String, String> {
    let sources = expand(&paths.iter().map(PathBuf::from).collect::<Vec<_>>())?;
    start_send(manager.inner().clone(), peer, sources, None)
}

#[tauri::command]
pub fn transfers_list() -> Vec<TransferStatus> {
    let mut list: Vec<TransferStatus> = TRANSFERS.lock().map(|all| all.as_ref().map(|m| m.values().map(|e| e.status.clone()).collect()).unwrap_or_default()).unwrap_or_default();
    list.sort_by_key(|s| std::cmp::Reverse(s.started_at));
    list
}

fn find_key(id: &str) -> Option<String> {
    let all = TRANSFERS.lock().ok()?;
    let all = all.as_ref()?;
    [format!("send:{id}"), format!("receive:{id}")].into_iter().find(|k| all.contains_key(k))
}

#[tauri::command]
pub fn transfer_cancel(id: String) -> Result<(), String> {
    let key = find_key(&id).ok_or("No such transfer")?;
    with_entry(&key, |e| e.cancel.store(true, Ordering::Relaxed));
    Ok(())
}

/// Tries a failed or cancelled send again, continuing where it stopped.
#[tauri::command]
pub fn transfer_resume(id: String, manager: State<'_, BridgeLinkManager>) -> Result<String, String> {
    let key = format!("send:{id}");
    let (peer, sources, state) = with_entry(&key, |e| (e.status.peer_id.clone(), e.sources.clone(), e.status.state.clone())).ok_or("No such transfer")?;
    if !matches!(state.as_str(), "failed" | "cancelled") {
        return Err("That transfer is still running".into());
    }
    start_send(manager.inner().clone(), peer, sources, Some(id))
}

/// Removes finished transfers from the list.
#[tauri::command]
pub fn transfers_clear() {
    if let Ok(mut all) = TRANSFERS.lock() {
        if let Some(all) = all.as_mut() {
            all.retain(|_, e| e.status.finished_at.is_none() || e.status.can_resume);
        }
    }
    changed();
}

#[cfg(test)]
pub fn status_of(direction: &str, id: &str) -> Option<TransferStatus> {
    with_entry(&format!("{direction}:{id}"), |e| e.status.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incoming_paths_cannot_leave_the_folder_and_are_valid_everywhere() {
        assert_eq!(safe_rel("Photos/2026/a.jpg"), Some(PathBuf::from("Photos").join("2026").join("a.jpg")));
        assert_eq!(safe_rel("../etc/passwd"), None);
        assert_eq!(safe_rel("a/../../b"), None);
        assert_eq!(safe_rel("/abs/x"), Some(PathBuf::from("abs").join("x")));
        assert_eq!(safe_rel("C:\\Windows\\x"), Some(PathBuf::from("C__Windows_x")));
        assert_eq!(safe_rel("notes: draft?.txt"), Some(PathBuf::from("notes_ draft_.txt")));
        assert_eq!(safe_rel("CON.txt"), Some(PathBuf::from("_CON.txt")));
        assert_eq!(safe_rel("name. "), Some(PathBuf::from("name")));
        assert_eq!(safe_rel(""), None);
        assert_eq!(safe_rel("..."), None);
    }

    #[test]
    fn folders_keep_their_layout_and_names_never_overwrite() {
        let root = std::env::temp_dir().join(format!("bd-expand-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("Trip/day 1")).unwrap();
        std::fs::write(root.join("Trip/day 1/a.jpg"), b"a").unwrap();
        std::fs::write(root.join("Trip/b.txt"), b"b").unwrap();
        std::fs::write(root.join("single.pdf"), b"c").unwrap();
        let files = expand(&[root.join("Trip"), root.join("single.pdf")]).unwrap();
        let rels: Vec<&str> = files.iter().map(|(_, r)| r.as_str()).collect();
        assert_eq!(rels, vec!["Trip/b.txt", "Trip/day 1/a.jpg", "single.pdf"]);
        assert_eq!(free_target(&root, Path::new("single.pdf")), root.join("single (1).pdf"));
        assert_eq!(free_target(&root, Path::new("new.pdf")), root.join("new.pdf"));
        assert!(expand(&[root.join("missing")]).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
