//! New messages as they arrive, instead of every few seconds.
//!
//! On the Mac, one thread notices when `chat.db` changes (its files' sizes and times, checked every
//! 400 ms; the database itself is only read when they change) and hands the new messages to whoever
//! listens: this computer's window (the `imessage-new` event) and paired computers following over a
//! long-lived link stream (`/messages/watch`). On the other computers a follower keeps that stream
//! open to the Mac, reconnecting by itself, and passes what arrives to the window the same way.
//! The window still checks now and then, so nothing is missed if the stream drops.

use super::{chat_db, chatdb};
use crate::bridgelink::BridgeLinkManager;
use crate::link::transport::{read_frame, write_frame, Request};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{mpsc, Mutex},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter};

pub const PATH: &str = "/messages/watch";
const CHECK: Duration = Duration::from_millis(400);
const PING: Duration = Duration::from_secs(25);

/// Listeners for new messages on the Mac.
static LISTENERS: Mutex<Vec<mpsc::Sender<Value>>> = Mutex::new(Vec::new());
static WATCHING: Mutex<bool> = Mutex::new(false);
/// Whether this computer is getting pushed messages from the Mac (for the window's status).
static FOLLOWING: Mutex<Option<String>> = Mutex::new(None);

/// What identifies the state of the database files: their sizes and modification times.
fn stamp(db: &Path) -> Vec<(u64, Option<SystemTime>)> {
    ["", "-wal"].iter().map(|suffix| {
        let path = std::path::PathBuf::from(format!("{}{suffix}", db.display()));
        std::fs::metadata(path).map(|m| (m.len(), m.modified().ok())).unwrap_or((0, None))
    }).collect()
}

/// New messages after `last` (updating it), when the database moved on.
pub fn new_since(db: &Path, last: &mut i64) -> Result<Vec<chatdb::Message>, String> {
    let conn = chatdb::open(db)?;
    let newest = chatdb::latest_rowid(&conn)?;
    if newest <= *last {
        *last = newest;
        return Ok(Vec::new());
    }
    let list = chatdb::since_rowid(&conn, *last, 200)?;
    *last = newest;
    Ok(list)
}

/// Starts the watcher thread once; it stops when nobody listens.
fn ensure_watching() {
    let mut watching = WATCHING.lock().unwrap_or_else(|e| e.into_inner());
    if *watching {
        return;
    }
    *watching = true;
    std::thread::spawn(|| {
        let db = chat_db();
        let mut last = chatdb::open(&db).and_then(|c| chatdb::latest_rowid(&c)).unwrap_or(0);
        let mut seen = stamp(&db);
        loop {
            std::thread::sleep(CHECK);
            if LISTENERS.lock().map(|l| l.is_empty()).unwrap_or(true) {
                break;
            }
            let now = stamp(&db);
            if now == seen {
                continue;
            }
            seen = now;
            let Ok(list) = new_since(&db, &mut last) else { continue };
            if list.is_empty() {
                continue;
            }
            let payload = json!({ "messages": list });
            if let Ok(mut listeners) = LISTENERS.lock() {
                listeners.retain(|tx| tx.send(payload.clone()).is_ok());
            }
        }
        *WATCHING.lock().unwrap_or_else(|e| e.into_inner()) = false;
    });
}

fn listen() -> mpsc::Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    LISTENERS.lock().unwrap_or_else(|e| e.into_inner()).push(tx);
    ensure_watching();
    rx
}

/// On the Mac: new messages go to this computer's window as they arrive.
pub fn start_local(app: AppHandle) {
    if !super::available() {
        return;
    }
    let rx = listen();
    std::thread::spawn(move || {
        for payload in rx {
            let _ = app.emit("imessage-new", json!({ "peer": Value::Null, "messages": payload["messages"] }));
        }
    });
}

/// On the Mac: a paired computer following new messages over the link.
pub async fn serve(mut send: quinn::SendStream, mut recv: quinn::RecvStream) {
    if !super::available() {
        let _ = write_frame(&mut send, &json!({ "type": "unavailable" })).await;
        let _ = send.finish();
        return;
    }
    let rx = listen();
    let (tx, mut out) = tokio::sync::mpsc::unbounded_channel::<Value>();
    // A plain thread waits on the watcher's channel and hands messages to the async side.
    std::thread::spawn(move || {
        while let Ok(payload) = rx.recv() {
            if tx.send(payload).is_err() {
                break;
            }
        }
    });
    if write_frame(&mut send, &json!({ "type": "ready" })).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            payload = out.recv() => {
                let Some(payload) = payload else { break };
                if write_frame(&mut send, &json!({ "type": "new", "messages": payload["messages"] })).await.is_err() {
                    break;
                }
            }
            _ = tokio::time::sleep(PING) => {
                if write_frame(&mut send, &json!({ "type": "ping" })).await.is_err() {
                    break;
                }
            }
            closed = read_frame::<Value>(&mut recv) => {
                if closed.is_err() {
                    break;
                }
            }
        }
    }
    let _ = send.finish();
}

/// Whether new messages are being pushed from the Mac, and from which one.
#[tauri::command]
pub fn imessage_push_status() -> Option<String> {
    FOLLOWING.lock().ok().and_then(|f| f.clone())
}

/// On the other computers: keep a stream open to the paired Mac and pass new messages to the window.
pub fn start_following(app: AppHandle, manager: BridgeLinkManager) {
    if super::available() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(5);
        loop {
            let Some(mac) = crate::bridgelink::peer::paired_macs(&manager).into_iter().next() else {
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            };
            let on = |event: Value| match event["type"].as_str() {
                Some("ready") => set_following(&app, Some(mac.clone())),
                Some("new") => drop(app.emit("imessage-new", json!({ "peer": mac, "messages": event["messages"] }))),
                _ => {}
            };
            match follow(&manager, &mac, &on).await {
                Ok(()) => wait = Duration::from_secs(5),
                Err(_) => wait = (wait * 2).min(Duration::from_secs(120)),
            }
            set_following(&app, None);
            tokio::time::sleep(wait).await;
        }
    });
}

fn set_following(app: &AppHandle, mac: Option<String>) {
    if let Ok(mut following) = FOLLOWING.lock() {
        if *following != mac {
            *following = mac.clone();
            let _ = app.emit("imessage-push", json!({ "peer": mac }));
        }
    }
}

/// Follows `mac` until the stream ends; `on` gets `{type: "ready"}` once, then each `{type: "new", messages}`.
pub async fn follow(manager: &BridgeLinkManager, mac: &str, on: &(dyn Fn(Value) + Send + Sync)) -> Result<(), String> {
    let (link, addresses, fingerprint) = crate::bridgelink::peer::link_to(manager, mac)?;
    let request = Request { method: "POST".into(), path: PATH.into(), body: String::new() };
    let (_send, mut recv) = link.open_stream(&addresses, &fingerprint, &request).await?;
    let first: Value = tokio::time::timeout(Duration::from_secs(15), read_frame(&mut recv)).await.map_err(|_| "no answer".to_string())??;
    if first["type"] != "ready" {
        return Err("The Mac doesn't push messages".into());
    }
    on(first);
    loop {
        // The Mac pings every 25 s; silence for longer means the stream is gone.
        let frame: Value = tokio::time::timeout(PING * 3, read_frame(&mut recv)).await.map_err(|_| "silent".to_string())??;
        if frame["type"] == "new" {
            on(frame);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_messages_added_since_the_last_check_are_new() {
        let dir = std::env::temp_dir().join(format!("bd-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chat.db");
        let db = chatdb::tests::fixture();
        db.execute("VACUUM INTO ?1", [path.to_string_lossy().to_string()]).unwrap();
        let before = stamp(&path);
        let mut last = 2;
        let first = new_since(&path, &mut last).unwrap();
        assert_eq!(first.iter().map(|m| m.guid.as_str()).collect::<Vec<_>>(), vec!["M3", "M4"]);
        assert_eq!(last, 4);
        assert!(new_since(&path, &mut last).unwrap().is_empty(), "nothing new the second time");

        // A message arrives: the files change, and only it is new.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me) SELECT 5, 'M5', 'new one', handle_id, date + 1000, 0 FROM message WHERE ROWID = 4;
                            INSERT INTO chat_message_join (chat_id, message_id) SELECT chat_id, 5 FROM chat_message_join WHERE message_id = 4;").unwrap();
        drop(conn);
        assert_ne!(stamp(&path), before);
        let arrived = new_since(&path, &mut last).unwrap();
        assert_eq!(arrived.iter().map(|m| (m.guid.as_str(), m.text.as_deref())).collect::<Vec<_>>(), vec![("M5", Some("new one"))]);
        assert!(!arrived[0].chats.is_empty(), "with its chat, like the feed");
        let _ = std::fs::remove_dir_all(dir);
    }
}
