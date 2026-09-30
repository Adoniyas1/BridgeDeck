//! Reads `~/Library/Messages/chat.db` (read-only). The JSON shapes match what the Messages UI already
//! renders (they started as BlueBubbles Server's), so the UI works unchanged against this reader.

use super::typedstream;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row};
use serde::Serialize;
use std::path::Path;

/// Seconds between 1970-01-01 and 2001-01-01 (Apple's epoch).
const APPLE_EPOCH_MS: i64 = 978_307_200_000;

/// Apple timestamps are nanoseconds since 2001 (seconds before macOS 10.13). 0 = not set.
pub fn apple_to_ms(value: i64) -> i64 {
    match value {
        0 => 0,
        v if v.abs() > 100_000_000_000 => v / 1_000_000 + APPLE_EPOCH_MS,
        v => v * 1000 + APPLE_EPOCH_MS,
    }
}

pub fn ms_to_apple(ms: i64) -> i64 {
    (ms - APPLE_EPOCH_MS).max(0) * 1_000_000
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Handle {
    pub address: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub guid: String,
    pub mime_type: Option<String>,
    pub transfer_name: String,
    pub total_bytes: i64,
    pub hide_attachment: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatRef {
    pub guid: String,
    pub display_name: String,
    pub chat_identifier: String,
    pub participants: Vec<Handle>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub guid: String,
    pub text: Option<String>,
    pub is_from_me: bool,
    pub date_created: i64,
    pub date_delivered: Option<i64>,
    pub date_read: Option<i64>,
    pub error: i64,
    pub item_type: i64,
    pub group_title: Option<String>,
    /// Tapbacks: "2000"–"2006" (added), "3000"–"3006" (removed). None for ordinary messages.
    pub associated_message_type: Option<String>,
    pub associated_message_guid: Option<String>,
    pub handle: Option<Handle>,
    pub attachments: Vec<Attachment>,
    /// Filled for the cross-chat feed (`recent`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub chats: Vec<ChatRef>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub guid: String,
    pub display_name: String,
    pub chat_identifier: String,
    pub participants: Vec<Handle>,
    pub last_message: Option<Message>,
}

/// Opens chat.db read-only. Messages keeps writing to it (WAL), which read-only readers handle.
pub fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| permission_hint(&e.to_string()))?;
    // Fails here (not at open) when macOS withholds access.
    connection.query_row("SELECT count(*) FROM chat LIMIT 1", [], |_| Ok(())).map_err(|e| permission_hint(&e.to_string()))?;
    connection.busy_timeout(std::time::Duration::from_secs(2)).map_err(|e| e.to_string())?;
    Ok(connection)
}

/// Which app macOS checks for Full Disk Access: BridgeDeck when installed, the terminal when it was
/// started with `npm run tauri dev` (macOS attributes the access to the app that launched it).
fn access_holder() -> &'static str {
    let installed = std::env::current_exe().ok().is_some_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"));
    if installed { "BridgeDeck" } else { "the Terminal app you started BridgeDeck from (Terminal, iTerm or your editor)" }
}

fn permission_hint(error: &str) -> String {
    if error.contains("unable to open") || error.contains("authorization denied") || error.contains("not authorized") || error.contains("operation not permitted") {
        format!(
            "BridgeDeck can't read your messages yet. Give Full Disk Access to {}: System Settings → Privacy & Security → Full Disk Access. Then quit it completely and open it again (macOS only applies the change after a restart). [{error}]",
            access_holder()
        )
    } else {
        format!("Could not read Messages: {error}")
    }
}

const MESSAGE_COLUMNS: &str = "m.ROWID, m.guid, m.text, m.attributedBody, m.is_from_me, m.date, m.date_delivered, m.date_read, m.error, m.item_type, m.group_title, m.associated_message_type, m.associated_message_guid, h.id, m.cache_has_attachments";

fn message_from_row(row: &Row) -> rusqlite::Result<(i64, Message, bool)> {
    let text: Option<String> = row.get(2)?;
    let body: Option<Vec<u8>> = row.get(3)?;
    let text = text.filter(|t| !t.is_empty()).or_else(|| body.as_deref().and_then(typedstream::text));
    let associated: i64 = row.get::<_, Option<i64>>(11)?.unwrap_or(0);
    let optional_ms = |value: Option<i64>| value.filter(|v| *v != 0).map(apple_to_ms);
    Ok((
        row.get(0)?,
        Message {
            guid: row.get(1)?,
            text,
            is_from_me: row.get::<_, i64>(4)? != 0,
            date_created: apple_to_ms(row.get(5)?),
            date_delivered: optional_ms(row.get(6)?),
            date_read: optional_ms(row.get(7)?),
            error: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
            item_type: row.get::<_, Option<i64>>(9)?.unwrap_or(0),
            group_title: row.get(10)?,
            associated_message_type: (associated != 0).then(|| associated.to_string()),
            associated_message_guid: row.get(12)?,
            handle: row.get::<_, Option<String>>(13)?.map(|address| Handle { address }),
            attachments: Vec::new(),
            chats: Vec::new(),
        },
        row.get::<_, Option<i64>>(14)?.unwrap_or(0) != 0,
    ))
}

fn attachments(db: &Connection, message_rowid: i64) -> rusqlite::Result<Vec<Attachment>> {
    let mut statement = db.prepare_cached(
        "SELECT a.guid, a.mime_type, a.transfer_name, a.filename, a.total_bytes, a.hide_attachment FROM attachment a
         JOIN message_attachment_join j ON j.attachment_id = a.ROWID WHERE j.message_id = ?1 ORDER BY a.ROWID",
    )?;
    let rows = statement.query_map([message_rowid], |row| {
        let filename: Option<String> = row.get(3)?;
        let transfer: Option<String> = row.get(2)?;
        Ok(Attachment {
            guid: row.get(0)?,
            mime_type: row.get(1)?,
            transfer_name: transfer
                .filter(|t| !t.is_empty())
                .or_else(|| filename.as_deref().and_then(|f| f.rsplit('/').next()).map(str::to_string))
                .unwrap_or_else(|| "Attachment".into()),
            total_bytes: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            hide_attachment: row.get::<_, Option<i64>>(5)?.unwrap_or(0) != 0,
        })
    })?;
    rows.collect()
}

fn with_attachments(db: &Connection, rows: Vec<(i64, Message, bool)>) -> rusqlite::Result<Vec<(i64, Message)>> {
    rows.into_iter()
        .map(|(rowid, mut message, has)| {
            if has {
                message.attachments = attachments(db, rowid)?;
            }
            Ok((rowid, message))
        })
        .collect()
}

fn participants(db: &Connection, chat_rowid: i64) -> rusqlite::Result<Vec<Handle>> {
    let mut statement = db.prepare_cached("SELECT h.id FROM handle h JOIN chat_handle_join j ON j.handle_id = h.ROWID WHERE j.chat_id = ?1 ORDER BY h.ROWID")?;
    let rows = statement.query_map([chat_rowid], |row| Ok(Handle { address: row.get(0)? }))?;
    rows.collect()
}

/// Some 1:1 chats have no `chat_handle_join` rows; the other person is then the chat identifier.
fn participants_or_identifier(db: &Connection, chat_rowid: i64, guid: &str, identifier: &str) -> rusqlite::Result<Vec<Handle>> {
    let list = participants(db, chat_rowid)?;
    if list.is_empty() && guid.contains(";-;") && !identifier.is_empty() {
        return Ok(vec![Handle { address: identifier.to_string() }]);
    }
    Ok(list)
}

fn chat_ref(db: &Connection, chat_rowid: i64) -> rusqlite::Result<Option<ChatRef>> {
    let chat = db
        .query_row("SELECT guid, COALESCE(display_name, ''), COALESCE(chat_identifier, '') FROM chat WHERE ROWID = ?1", [chat_rowid], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })
        .optional()?;
    Ok(match chat {
        Some((guid, display_name, chat_identifier)) => {
            let participants = participants_or_identifier(db, chat_rowid, &guid, &chat_identifier)?;
            Some(ChatRef { guid, display_name, chat_identifier, participants })
        }
        None => None,
    })
}

/// Most recently active chats, each with its newest message.
pub fn chats(db: &Connection, limit: u32) -> Result<Vec<Chat>, String> {
    let run = || -> rusqlite::Result<Vec<Chat>> {
        let mut statement = db.prepare(
            "SELECT c.ROWID, c.guid, COALESCE(c.display_name, ''), COALESCE(c.chat_identifier, ''), MAX(j.message_date) AS last
             FROM chat c LEFT JOIN chat_message_join j ON j.chat_id = c.ROWID
             GROUP BY c.ROWID ORDER BY last IS NULL, last DESC LIMIT ?1",
        )?;
        let rows: Vec<(i64, String, String, String)> = statement
            .query_map([limit.min(500)], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        rows.into_iter()
            .map(|(rowid, guid, display_name, chat_identifier)| {
                let last = newest_in_chat(db, rowid)?;
                let participants = participants_or_identifier(db, rowid, &guid, &chat_identifier)?;
                Ok(Chat { guid, display_name, chat_identifier, participants, last_message: last })
            })
            .collect()
    };
    run().map_err(|e| e.to_string())
}

fn newest_in_chat(db: &Connection, chat_rowid: i64) -> rusqlite::Result<Option<Message>> {
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE j.chat_id = ?1 AND COALESCE(m.associated_message_type, 0) = 0 ORDER BY m.date DESC LIMIT 1"
    );
    let row = db.query_row(&sql, [chat_rowid], message_from_row).optional()?;
    Ok(match row {
        Some(row) => with_attachments(db, vec![row])?.pop().map(|(_, m)| m),
        None => None,
    })
}

/// The newest `limit` messages of one chat (newest first), including tapbacks.
pub fn messages(db: &Connection, chat_guid: &str, limit: u32) -> Result<Vec<Message>, String> {
    let run = || -> rusqlite::Result<Vec<Message>> {
        let sql = format!(
            "SELECT {MESSAGE_COLUMNS} FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id
             LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE c.guid = ?1 ORDER BY m.date DESC LIMIT ?2"
        );
        let mut statement = db.prepare(&sql)?;
        let rows: Vec<_> = statement.query_map(params![chat_guid, limit.min(500)], message_from_row)?.collect::<rusqlite::Result<_>>()?;
        Ok(with_attachments(db, rows)?.into_iter().map(|(_, m)| m).collect())
    };
    run().map_err(|e| e.to_string())
}

/// Messages in any chat created after `after_ms` (oldest first), each with its chat.
pub fn recent(db: &Connection, after_ms: i64, limit: u32) -> Result<Vec<Message>, String> {
    let run = || -> rusqlite::Result<Vec<Message>> {
        let sql = format!(
            "SELECT {MESSAGE_COLUMNS}, j.chat_id FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID
             LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.date > ?1 ORDER BY m.date DESC LIMIT ?2"
        );
        let mut statement = db.prepare(&sql)?;
        let rows: Vec<((i64, Message, bool), i64)> = statement
            .query_map(params![ms_to_apple(after_ms), limit.min(2000)], |row| Ok((message_from_row(row)?, row.get(15)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut chats = std::collections::HashMap::new();
        let mut out = Vec::with_capacity(rows.len());
        for (row, chat_rowid) in rows.into_iter().rev() {
            let (_, mut message) = with_attachments(db, vec![row])?.pop().expect("one row");
            if !chats.contains_key(&chat_rowid) {
                chats.insert(chat_rowid, chat_ref(db, chat_rowid)?);
            }
            if let Some(Some(chat)) = chats.get(&chat_rowid) {
                message.chats = vec![chat.clone()];
            }
            out.push(message);
        }
        Ok(out)
    };
    run().map_err(|e| e.to_string())
}

/// Where an attachment's file is, and its type. `~` is expanded by the caller.
pub fn attachment_file(db: &Connection, guid: &str) -> Result<(String, Option<String>, String), String> {
    db.query_row("SELECT filename, mime_type, COALESCE(transfer_name, '') FROM attachment WHERE guid = ?1", [guid], |row| {
        Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?))
    })
    .optional()
    .map_err(|e| e.to_string())?
    .and_then(|(file, mime, name)| file.map(|file| (file, mime, name)))
    .ok_or_else(|| "Attachment not found (it may not be downloaded to the Mac yet)".to_string())
}

/// The newest message's row id: a cheap "did anything change" check.
pub fn latest_rowid(db: &Connection) -> Result<i64, String> {
    db.query_row("SELECT COALESCE(MAX(ROWID), 0) FROM message", [], |row| row.get(0)).map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A chat.db with the tables and columns BridgeDeck reads (macOS 13–15 layout).
    pub(crate) fn fixture() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
             CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT, style INTEGER);
             CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, service TEXT,
               is_from_me INTEGER, date INTEGER, date_read INTEGER, date_delivered INTEGER, error INTEGER, item_type INTEGER, group_title TEXT,
               associated_message_guid TEXT, associated_message_type INTEGER, cache_has_attachments INTEGER);
             CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
             CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
             CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER, hide_attachment INTEGER);
             CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
             INSERT INTO handle VALUES (1, '+15551234567', 'iMessage'), (2, 'friend@example.com', 'iMessage');
             INSERT INTO chat VALUES (1, 'iMessage;-;+15551234567', '+15551234567', '', 'iMessage', 45),
                                     (2, 'iMessage;+;chat123', 'chat123', 'Weekend', 'iMessage', 43);
             INSERT INTO chat VALUES (3, 'SMS;-;+15559876543', '+15559876543', '', 'SMS', 45);
             INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2);",
        )
        .unwrap();
        let add = |rowid: i64, chat: i64, handle: i64, from_me: bool, ms: i64, text: Option<&str>, body: Option<Vec<u8>>, assoc: (i64, Option<&str>), attach: bool| {
            db.execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5, 'iMessage', ?6, ?7, 0, ?7, 0, 0, NULL, ?8, ?9, ?10)",
                params![rowid, format!("M{rowid}"), text, body, handle, from_me as i64, ms_to_apple(ms), assoc.1, assoc.0, attach as i64],
            )
            .unwrap();
            db.execute("INSERT INTO chat_message_join VALUES (?1, ?2, ?3)", params![chat, rowid, ms_to_apple(ms)]).unwrap();
        };
        let t = 1_750_000_000_000;
        add(1, 1, 1, false, t, Some("Hi there"), None, (0, None), false);
        add(2, 1, 0, true, t + 1_000, None, Some(typedstream::archive("Ventura keeps text here")), (0, None), false);
        add(3, 2, 2, false, t + 2_000, Some("\u{fffc}"), None, (0, None), true);
        add(4, 1, 1, false, t + 3_000, Some("Loved “Hi there”"), None, (2000, Some("p:0/M2")), false);
        db.execute_batch(
            "INSERT INTO attachment VALUES (1, 'A1', '~/Library/Messages/Attachments/ab/01/photo.heic', 'image/heic', 'photo.heic', 2048, 0);
             INSERT INTO message_attachment_join VALUES (3, 1);",
        )
        .unwrap();
        db
    }

    #[test]
    fn dates_convert_both_ways() {
        let ms = 1_750_000_000_123;
        assert_eq!(apple_to_ms(ms_to_apple(ms)), ms);
        assert_eq!(apple_to_ms(0), 0);
        assert_eq!(apple_to_ms(700_000_000), 700_000_000_000 + APPLE_EPOCH_MS, "seconds on old macOS");
    }

    #[test]
    fn chats_newest_first_with_last_message() {
        let db = fixture();
        let list = chats(&db, 10).unwrap();
        assert_eq!(list.iter().map(|c| c.guid.as_str()).collect::<Vec<_>>(), vec!["iMessage;-;+15551234567", "iMessage;+;chat123", "SMS;-;+15559876543"], "chats with no messages come last");
        // Tapbacks aren't a chat's last message.
        assert_eq!(list[0].last_message.as_ref().unwrap().text.as_deref(), Some("Ventura keeps text here"));
        assert_eq!(list[1].display_name, "Weekend");
        assert_eq!(list[1].participants.len(), 2);
        assert_eq!(list[1].last_message.as_ref().unwrap().attachments[0].mime_type.as_deref(), Some("image/heic"));
        // A 1:1 chat without participant rows still names its person (so the UI can find the contact).
        let sms = list.iter().find(|c| c.guid == "SMS;-;+15559876543").unwrap();
        assert_eq!(sms.participants, vec![Handle { address: "+15559876543".into() }]);
    }

    #[test]
    fn messages_of_a_chat_decode_attributed_bodies_and_tapbacks() {
        let db = fixture();
        let list = messages(&db, "iMessage;-;+15551234567", 50).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].associated_message_type.as_deref(), Some("2000"));
        assert_eq!(list[0].associated_message_guid.as_deref(), Some("p:0/M2"));
        assert_eq!(list[1].text.as_deref(), Some("Ventura keeps text here"));
        assert!(list[1].is_from_me && list[1].handle.is_none());
        assert_eq!(list[2].handle.as_ref().unwrap().address, "+15551234567");
        let json = serde_json::to_value(&list[2]).unwrap();
        assert!(json.get("dateCreated").is_some() && json.get("isFromMe").is_some() && json.get("chats").is_none());
    }

    #[test]
    fn recent_feed_is_oldest_first_with_chats() {
        let db = fixture();
        let list = recent(&db, 1_750_000_000_500, 100).unwrap();
        assert_eq!(list.iter().map(|m| m.guid.as_str()).collect::<Vec<_>>(), vec!["M2", "M3", "M4"]);
        assert_eq!(list[1].chats[0].guid, "iMessage;+;chat123");
        assert_eq!(list[1].attachments[0].transfer_name, "photo.heic");
        assert_eq!(latest_rowid(&db).unwrap(), 4);
        assert_eq!(attachment_file(&db, "A1").unwrap().0, "~/Library/Messages/Attachments/ab/01/photo.heic");
        assert!(attachment_file(&db, "nope").is_err());
    }
}
