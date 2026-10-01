//! Messages served by the Mac (roadmap Phase 4), replacing BlueBubbles Server.
//!
//! On the Mac, BridgeDeck reads `~/Library/Messages/chat.db` and the Contacts databases read-only and
//! sends through Messages.app with AppleScript. It needs Full Disk Access (to read) and Automation
//! permission for Messages (to send), for BridgeDeck only. Other devices ask the Mac over the
//! encrypted link (`POST /messages`); this computer's UI calls [`imessage`] with no peer.
//!
//! Known limits without Apple's private APIs: no tapbacks, typing indicators, edit/unsend or read
//! receipts from here. Text, group chats, attachments and SMS (with iPhone Text Message Forwarding) work.

pub mod chatdb;
pub mod contacts;
pub mod typedstream;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

/// Attachment bytes per request over the link (base64 keeps each frame under 1 MB).
pub const CHUNK: usize = 512 * 1024;
const MAX_ATTACHMENT: u64 = 100 * 1024 * 1024;
const MAX_UPLOAD: u64 = 100 * 1024 * 1024;
const SENDS_PER_MINUTE: usize = 30;

/// One request to the Mac's Messages engine.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    Status,
    Chats { #[serde(default = "default_limit")] limit: u32 },
    Messages { chat: String, #[serde(default = "default_limit")] limit: u32 },
    Recent { after: i64, #[serde(default = "default_limit")] limit: u32 },
    Contacts,
    /// Part of an attachment's bytes (images converted to JPEG when the other side can't show HEIC).
    Attachment { guid: String, #[serde(default)] offset: u64 },
    Send { chat: String, text: String },
    /// A file for `chat`, in chunks; sent when `done`.
    Upload { upload: String, chat: String, name: String, offset: u64, data: String, done: bool },
}

fn default_limit() -> u32 {
    100
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn chat_db() -> PathBuf {
    std::env::var_os("BRIDGEDECK_CHAT_DB").map(PathBuf::from).unwrap_or_else(|| home().join("Library/Messages/chat.db"))
}

/// Whether this computer serves Messages.
pub fn available() -> bool {
    cfg!(target_os = "macos") || std::env::var_os("BRIDGEDECK_CHAT_DB").is_some()
}

/// Answers one request on the Mac.
pub fn handle(op: Op) -> Result<Value, String> {
    if !available() {
        return Err("Messages are read on the Mac. Pair your Mac to see them here.".into());
    }
    match op {
        Op::Status => {
            let db = chatdb::open(&chat_db());
            Ok(json!({ "available": db.is_ok(), "detail": db.err(), "platform": std::env::consts::OS }))
        }
        Op::Chats { limit } => to_value(chatdb::chats(&chatdb::open(&chat_db())?, limit)?),
        Op::Messages { chat, limit } => to_value(chatdb::messages(&chatdb::open(&chat_db())?, &clean_guid(&chat)?, limit)?),
        Op::Recent { after, limit } => to_value(chatdb::recent(&chatdb::open(&chat_db())?, after, limit)?),
        Op::Contacts => to_value(cached_contacts()?),
        Op::Attachment { guid, offset } => attachment_chunk(&clean_guid(&guid)?, offset),
        Op::Send { chat, text } => {
            let text = text.trim_end().to_string();
            if text.trim().is_empty() || text.len() > 20_000 {
                return Err("Message is empty or too long".into());
            }
            reserve_send()?;
            send(&clean_guid(&chat)?, "text", &text)?;
            Ok(json!({ "sent": true }))
        }
        Op::Upload { upload, chat, name, offset, data, done } => receive_upload(&upload, &clean_guid(&chat)?, &name, offset, &data, done),
    }
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// Chat and attachment guids: `iMessage;-;+15551234567`, `SMS;+;chat123`, `any;-;a@b.c`, UUIDs.
fn clean_guid(value: &str) -> Result<String, String> {
    let ok = !value.is_empty() && value.len() <= 200 && value.chars().all(|c| c.is_ascii_alphanumeric() || "-;+@._:/".contains(c));
    if ok { Ok(value.to_string()) } else { Err("Invalid id".into()) }
}

static CONTACTS: Mutex<Option<(Instant, Vec<contacts::Contact>)>> = Mutex::new(None);

fn cached_contacts() -> Result<Vec<contacts::Contact>, String> {
    let mut cache = CONTACTS.lock().map_err(|_| "contacts cache poisoned")?;
    if let Some((at, list)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(120) {
            return Ok(list.clone());
        }
    }
    let list = contacts::all(&home())?;
    *cache = Some((Instant::now(), list.clone()));
    Ok(list)
}

/// Contact edits change the database; the next list reads it again.
pub fn forget_contacts() {
    if let Ok(mut cache) = CONTACTS.lock() {
        *cache = None;
    }
}

static SENDS: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

fn reserve_send() -> Result<(), String> {
    let mut sends = SENDS.lock().map_err(|_| "send limiter poisoned")?;
    sends.retain(|at| at.elapsed() < Duration::from_secs(60));
    if sends.len() >= SENDS_PER_MINUTE {
        return Err("Too many messages in a minute; wait a moment".into());
    }
    sends.push(Instant::now());
    Ok(())
}

/// An attachment's file on the Mac. Only files under `~/Library/Messages` are served.
fn attachment_path(guid: &str) -> Result<(PathBuf, Option<String>, String), String> {
    let (file, mime, name) = chatdb::attachment_file(&chatdb::open(&chat_db())?, guid)?;
    let path = match file.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(&file),
    };
    let path = path.canonicalize().map_err(|_| "The attachment isn't on the Mac (it may still be in iCloud)".to_string())?;
    let allowed = home().join("Library/Messages").canonicalize().unwrap_or_else(|_| home().join("Library/Messages"));
    if !path.starts_with(&allowed) && std::env::var_os("BRIDGEDECK_CHAT_DB").is_none() {
        return Err("Attachment is outside the Messages folder".into());
    }
    Ok((path, mime, name))
}

/// HEIC/HEIF photos and TIFFs are converted to JPEG (Windows can't show them), once, into a cache.
fn displayable(path: &Path, mime: Option<String>) -> (PathBuf, Option<String>) {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    let convert = mime.as_deref().is_some_and(|m| matches!(m, "image/heic" | "image/heif" | "image/tiff")) || lower.ends_with(".heic") || lower.ends_with(".heif");
    if !convert || !cfg!(target_os = "macos") {
        return (path.to_path_buf(), mime);
    }
    let cache = std::env::temp_dir().join("bridgedeck-messages");
    let _ = std::fs::create_dir_all(&cache);
    let key: String = lower.bytes().fold(0u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64)).to_string();
    let out = cache.join(format!("{key}.jpg"));
    if !out.is_file() {
        let converted = std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "jpeg", "-Z", "2048"])
            .arg(path)
            .arg("--out")
            .arg(&out)
            .output()
            .is_ok_and(|o| o.status.success());
        if !converted {
            return (path.to_path_buf(), mime);
        }
    }
    (out, Some("image/jpeg".into()))
}

fn attachment_chunk(guid: &str, offset: u64) -> Result<Value, String> {
    use std::io::{Read, Seek, SeekFrom};
    let (path, mime, name) = attachment_path(guid)?;
    let (path, mime) = displayable(&path, mime);
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size > MAX_ATTACHMENT {
        return Err("Attachment is too large to show here; open it on the Mac".into());
    }
    file.seek(SeekFrom::Start(offset.min(size))).map_err(|e| e.to_string())?;
    let mut buffer = Vec::with_capacity(CHUNK);
    file.take(CHUNK as u64).read_to_end(&mut buffer).map_err(|e| e.to_string())?;
    Ok(json!({
        "name": name,
        "mimeType": mime.unwrap_or_else(|| "application/octet-stream".into()),
        "size": size,
        "offset": offset,
        "data": base64::engine::general_purpose::STANDARD.encode(&buffer),
    }))
}

/// Uploads in progress: id -> (file, bytes so far, started).
static UPLOADS: Mutex<Option<HashMap<String, (PathBuf, u64, Instant)>>> = Mutex::new(None);

fn clean_file_name(name: &str) -> Result<String, String> {
    let name: String = name.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':')).take(120).collect();
    let name = name.trim().trim_start_matches('.').to_string();
    if name.is_empty() { Err("Invalid file name".into()) } else { Ok(name) }
}

fn receive_upload(upload: &str, chat: &str, name: &str, offset: u64, data: &str, done: bool) -> Result<Value, String> {
    use std::io::Write;
    if upload.is_empty() || upload.len() > 64 || !upload.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Invalid upload id".into());
    }
    let upload = upload.to_string();
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "Invalid file data")?;
    let mut uploads = UPLOADS.lock().map_err(|_| "uploads poisoned")?;
    let uploads = uploads.get_or_insert_with(HashMap::new);
    uploads.retain(|_, (path, _, started)| {
        let keep = started.elapsed() < Duration::from_secs(600);
        if !keep {
            let _ = std::fs::remove_file(path);
        }
        keep
    });
    if offset == 0 && !uploads.contains_key(&upload) {
        // Messages (sandboxed) can send files from ~/Pictures; its own folders are off limits.
        let dir = home().join("Pictures/BridgeDeck Sent");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{}-{}", &upload[..upload.len().min(8)], clean_file_name(name)?));
        std::fs::File::create(&path).map_err(|e| e.to_string())?;
        uploads.insert(upload.clone(), (path, 0, Instant::now()));
    }
    let (path, received, _) = uploads.get_mut(&upload).ok_or("Upload not found")?;
    if offset != *received {
        return Err("Upload out of order".into());
    }
    if *received + bytes.len() as u64 > MAX_UPLOAD {
        return Err("File is too large to send (100 MB)".into());
    }
    let mut file = std::fs::OpenOptions::new().append(true).open(&*path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    *received += bytes.len() as u64;
    if !done {
        return Ok(json!({ "received": *received }));
    }
    let path = path.clone();
    uploads.remove(&upload);
    reserve_send()?;
    send(chat, "file", &path.to_string_lossy())?;
    Ok(json!({ "sent": true }))
}

// Variable names carry a `bd` prefix: plain words like `kind` or `target` are AppleScript or
// Messages terms, and assigning them fails (error -10006).
/// Sends through Messages.app; arguments: chat id, "text" or "file", the text or file path.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SEND_SCRIPT: &str = r#"on run argv
	set bdChatId to item 1 of argv
	set bdMode to item 2 of argv
	set bdPayload to item 3 of argv
	set bdHandle to ""
	if bdChatId contains ";-;" then set bdHandle to text ((offset of ";-;" in bdChatId) + 3) thru -1 of bdChatId
	if bdMode is "file" then set bdFile to POSIX file bdPayload
	tell application "Messages"
		try
			set bdChat to chat id bdChatId
		on error
			-- A 1:1 conversation Messages hasn't opened this session: address the person instead.
			if bdHandle is "" then error "Messages doesn't know this conversation"
			if bdChatId starts with "SMS" then
				set bdChat to participant bdHandle of (1st account whose service type = SMS)
			else
				set bdChat to participant bdHandle of (1st account whose service type = iMessage)
			end if
		end try
		if bdMode is "file" then
			send bdFile to bdChat
		else
			send bdPayload to bdChat
		end if
	end tell
end run"#;

/// Sends through Messages.app. Values are passed as arguments, never pasted into the script.
#[cfg(target_os = "macos")]
fn send(chat: &str, kind: &str, payload: &str) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(SEND_SCRIPT)
        .args([chat, kind, payload])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let error = String::from_utf8_lossy(&output.stderr);
    Err(if error.contains("-1743") || error.contains("Not authorized") {
        "Allow BridgeDeck to control Messages: System Settings → Privacy & Security → Automation → BridgeDeck → Messages.".into()
    } else {
        format!("Messages could not send it: {}", error.trim())
    })
}

#[cfg(not(target_os = "macos"))]
fn send(_chat: &str, _kind: &str, _payload: &str) -> Result<(), String> {
    Err("Messages can only send from the Mac".into())
}

/// A Messages request from Mimir: answered here on the Mac, or by the paired Mac.
pub fn query(manager: &crate::bridgelink::BridgeLinkManager, op: Value) -> Result<Value, String> {
    if available() {
        return run(manager, None, op);
    }
    let mac = crate::bridgelink::peer::paired_macs(manager).into_iter().next().ok_or("Messages needs a paired Mac")?;
    run(manager, Some(mac), op)
}

// ---- Tauri commands: this computer's UI. With `peer`, the request goes to that paired Mac. ----

fn run(manager: &crate::bridgelink::BridgeLinkManager, peer: Option<String>, op: Value) -> Result<Value, String> {
    match peer.filter(|p| !p.is_empty()) {
        None => handle(serde_json::from_value(op).map_err(|e| format!("Invalid request: {e}"))?),
        Some(peer) => crate::bridgelink::peer::forward_messages(manager, &peer, op),
    }
}

#[tauri::command]
pub async fn imessage(peer: Option<String>, op: Value, manager: tauri::State<'_, crate::bridgelink::BridgeLinkManager>) -> Result<Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run(&manager, peer, op)).await.map_err(|e| e.to_string())?
}

/// An attachment as a `data:` URL (fetched in chunks from the Mac).
#[tauri::command]
pub async fn imessage_attachment(peer: Option<String>, guid: String, manager: tauri::State<'_, crate::bridgelink::BridgeLinkManager>) -> Result<String, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut bytes = Vec::new();
        let mut mime = String::from("application/octet-stream");
        loop {
            let chunk = run(&manager, peer.clone(), json!({ "op": "attachment", "guid": guid, "offset": bytes.len() }))?;
            let data = base64::engine::general_purpose::STANDARD.decode(chunk["data"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
            mime = chunk["mimeType"].as_str().unwrap_or(&mime).to_string();
            let size = chunk["size"].as_u64().unwrap_or(0);
            if data.is_empty() && (bytes.len() as u64) < size {
                return Err("The attachment stopped downloading".into());
            }
            bytes.extend_from_slice(&data);
            if bytes.len() as u64 >= size {
                break;
            }
        }
        Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sends a file from this computer into `chat`.
#[tauri::command]
pub async fn imessage_send_file(peer: Option<String>, chat: String, path: String, manager: tauri::State<'_, crate::bridgelink::BridgeLinkManager>) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_UPLOAD {
            return Err("File is too large to send (100 MB)".into());
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        let upload = uuid::Uuid::new_v4().simple().to_string();
        let chunks: Vec<&[u8]> = if bytes.is_empty() { vec![&[][..]] } else { bytes.chunks(CHUNK).collect() };
        let mut offset = 0usize;
        for (index, chunk) in chunks.iter().enumerate() {
            let data = base64::engine::general_purpose::STANDARD.encode(chunk);
            run(&manager, peer.clone(), json!({ "op": "upload", "upload": upload, "chat": chat, "name": name, "offset": offset, "data": data, "done": index + 1 == chunks.len() }))?;
            offset += chunk.len();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_script_avoids_reserved_words() {
        // `kind`, `target`, `name`, `id`, `text`, `file` are AppleScript/Messages terms: assigning one fails.
        for word in ["kind", "target", "name", "id", "text", "file", "payload"] {
            assert!(!SEND_SCRIPT.contains(&format!("set {word} to")), "assigns reserved word {word}");
        }
        assert!(SEND_SCRIPT.contains("item 1 of argv") && SEND_SCRIPT.contains("send bdPayload to bdChat"));
    }

    #[test]
    fn ids_and_names_are_checked() {
        assert!(clean_guid("iMessage;-;+15551234567").is_ok());
        assert!(clean_guid("any;+;chat123@x.y").is_ok());
        assert!(clean_guid("x\" & do shell script \"").is_err());
        assert!(clean_guid("").is_err());
        assert_eq!(clean_file_name("../../etc/passwd").unwrap(), "etcpasswd");
        assert_eq!(clean_file_name("photo 1.jpg").unwrap(), "photo 1.jpg");
        assert!(clean_file_name("..").is_err());
    }

    #[test]
    fn requests_parse_from_json() {
        let op: Op = serde_json::from_value(json!({ "op": "messages", "chat": "iMessage;-;+1555", "limit": 5 })).unwrap();
        assert!(matches!(op, Op::Messages { limit: 5, .. }));
        let op: Op = serde_json::from_value(json!({ "op": "chats" })).unwrap();
        assert!(matches!(op, Op::Chats { limit: 100 }));
        assert!(serde_json::from_value::<Op>(json!({ "op": "shell" })).is_err());
    }

    #[test]
    fn serves_a_chat_db_file_end_to_end() {
        // The same fixture as chatdb's tests, on disk, through the request API.
        let dir = std::env::temp_dir().join(format!("bd-imessage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chat.db");
        chatdb::tests::fixture().execute("VACUUM INTO ?1", [path.to_string_lossy()]).unwrap();
        let photo = dir.join("photo.jpg");
        std::fs::write(&photo, vec![7u8; CHUNK + 10]).unwrap();
        rusqlite::Connection::open(&path).unwrap().execute("UPDATE attachment SET filename = ?1, mime_type = 'image/jpeg'", [photo.to_string_lossy()]).unwrap();
        std::env::set_var("BRIDGEDECK_CHAT_DB", &path);

        let chats = handle(Op::Chats { limit: 10 }).unwrap();
        assert_eq!(chats[0]["guid"], "iMessage;-;+15551234567");
        let recent = handle(Op::Recent { after: 0, limit: 10 }).unwrap();
        assert_eq!(recent.as_array().unwrap().len(), 4);
        let first = handle(Op::Attachment { guid: "A1".into(), offset: 0 }).unwrap();
        assert_eq!(first["size"], CHUNK as u64 + 10);
        let second = handle(Op::Attachment { guid: "A1".into(), offset: CHUNK as u64 }).unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(second["data"].as_str().unwrap()).unwrap().len(), 10);
        assert!(handle(Op::Messages { chat: "bad\"id".into(), limit: 1 }).is_err());
        std::env::remove_var("BRIDGEDECK_CHAT_DB");
        let _ = std::fs::remove_dir_all(dir);
    }
}
