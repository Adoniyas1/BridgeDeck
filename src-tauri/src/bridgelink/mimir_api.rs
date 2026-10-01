//! Mimir's toolbox: what the assistant can read and do in BridgeDeck, on the loopback API under
//! `/mimir/`. Only the Mimir process BridgeDeck started knows the token (`mimir_host::api_token`).
//!
//! Reading (notes, calendar, Messages, computers, clipboard, AI rooms) and editing your own notes and
//! calendar happen directly. Anything that leaves this computer for someone or somewhere else —
//! sending a message, sending files — first asks you in a BridgeDeck dialog.

use super::*;
use crate::bridgelink::notes::Note;
use serde_json::{json, Value};

/// Mimir's long-term memory is this note (visible and editable in the Notes tab).
pub const MEMORY_NOTE_ID: &str = "mimir-memory";

fn text<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(|v| v.as_str())
}

fn need<'a>(body: &'a Value, key: &str) -> Result<&'a str, String> {
    text(body, key).filter(|v| !v.trim().is_empty()).ok_or(format!("`{key}` is required"))
}

/// Asks the person before Mimir does something on their behalf outside this computer.
fn confirm(manager: &BridgeLinkManager, title: &str, message: &str, ok: &str) -> bool {
    let Some(app) = manager.lock().ok().and_then(|r| r.app.clone()) else { return false };
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog().message(message).title(title).kind(MessageDialogKind::Info).buttons(MessageDialogButtons::OkCancelCustom(ok.into(), "Don't".into())).blocking_show()
}

pub(super) fn route(manager: &BridgeLinkManager, path: &str, body: &str) -> (u16, String) {
    let body: Value = if body.trim().is_empty() { json!({}) } else {
        match serde_json::from_str(body) {
            Ok(value) => value,
            Err(_) => return (400, r#"{"ok":false,"error":"Expected a JSON body"}"#.into()),
        }
    };
    match handle(manager, path, &body) {
        Ok(result) => (200, json!({ "ok": true, "result": result }).to_string()),
        Err(error) if error == "Not found" => (404, r#"{"ok":false,"error":"Not found"}"#.into()),
        Err(error) => (409, json!({ "ok": false, "error": error }).to_string()),
    }
}

fn handle(manager: &BridgeLinkManager, path: &str, body: &Value) -> Result<Value, String> {
    match path {
        // ---- Notes and checklists ----
        "/mimir/notes/search" => {
            let query = text(body, "query").unwrap_or("").to_lowercase();
            let words: Vec<&str> = query.split_whitespace().collect();
            let limit = body.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).min(100) as usize;
            let notes = manager.lock()?.notes.list();
            let found: Vec<Value> = notes
                .iter()
                .filter(|n| {
                    let hay = format!("{}\n{}\n{}", n.title, n.folder, n.blocks.iter().filter(|b| !b.deleted).map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n")).to_lowercase();
                    words.iter().all(|w| hay.contains(w))
                })
                .take(limit)
                .map(|n| json!({ "id": n.id, "title": notes::display_title(n), "folder": n.folder, "kind": n.kind, "pinned": n.pinned, "preview": notes::preview(n, 160), "updated": n.updated() }))
                .collect();
            Ok(json!(found))
        }
        "/mimir/notes/read" => {
            let note = find_note(manager, need(body, "id")?)?;
            Ok(json!({ "id": note.id, "title": note.title, "folder": note.folder, "kind": note.kind, "updated": note.updated(), "markdown": notes::to_markdown(&note) }))
        }
        "/mimir/notes/create" => {
            let kind = if text(body, "kind") == Some("list") { "list" } else { "note" };
            let id = text(body, "id").filter(|id| *id == MEMORY_NOTE_ID).map(str::to_string);
            let markdown = text(body, "markdown").unwrap_or("").to_string();
            let (title, folder) = (text(body, "title").unwrap_or("").to_string(), text(body, "folder").unwrap_or("").to_string());
            let note = notes_change(manager, move |store, device, now| store.create_from_markdown(id, kind, &title, &folder, &markdown, device, now))?;
            Ok(json!({ "id": note.id }))
        }
        "/mimir/notes/append" => {
            let id = need(body, "id")?.to_string();
            let markdown = text(body, "markdown").unwrap_or("").to_string();
            let note = notes_change(manager, move |store, device, now| store.append_markdown(&id, &markdown, device, now))?;
            Ok(json!({ "id": note.id, "markdown": notes::to_markdown(&note) }))
        }
        "/mimir/notes/replace" => {
            let id = need(body, "id")?.to_string();
            let markdown = text(body, "markdown").unwrap_or("").to_string();
            let note = notes_change(manager, move |store, device, now| store.replace_markdown(&id, &markdown, device, now))?;
            Ok(json!({ "id": note.id, "updated": note.updated(), "markdown": notes::to_markdown(&note) }))
        }
        "/mimir/checklist/set" => {
            let (id, item) = (need(body, "id")?.to_string(), need(body, "item")?.to_string());
            let done = body.get("done").and_then(|v| v.as_bool()).unwrap_or(true);
            let changed = notes_change(manager, move |store, device, now| store.set_item(&id, &item, done, device, now))?;
            Ok(json!({ "changed": changed }))
        }

        // ---- Calendar ----
        "/mimir/calendar/events" => Ok(json!(manager.lock()?.calendar.list())),
        "/mimir/calendar/add" => {
            let mut raw = body.clone();
            if raw.get("id").and_then(|v| v.as_str()).is_none_or(|id| id.is_empty()) {
                raw["id"] = json!(Uuid::new_v4().to_string());
            }
            let mut event: calendar::Event = serde_json::from_value(raw).map_err(|e| format!("Invalid event: {e}"))?;
            if event.color.is_empty() {
                event.color = "purple".into();
            }
            let saved = calendar_change(manager, move |store, device, now| store.save_from_ui(event, device, now))?;
            Ok(json!(saved))
        }
        "/mimir/calendar/delete" => {
            let id = need(body, "id")?.to_string();
            Ok(json!(calendar_change(manager, move |store, device, now| Ok(store.delete(&id, device, now)))?))
        }

        // ---- Messages (read freely; sending asks first) ----
        "/mimir/messages" => {
            let op = match text(body, "op").unwrap_or("chats") {
                "chats" => json!({ "op": "chats", "limit": body.get("limit").and_then(|v| v.as_u64()).unwrap_or(30).min(200) }),
                "messages" => json!({ "op": "messages", "chat": need(body, "chat")?, "limit": body.get("limit").and_then(|v| v.as_u64()).unwrap_or(30).min(200) }),
                "recent" => json!({ "op": "recent", "after": body.get("after").and_then(|v| v.as_i64()).unwrap_or(0), "limit": 100 }),
                _ => return Err("op must be chats, messages or recent".into()),
            };
            crate::imessage::query(manager, op)
        }
        "/mimir/messages/send" => {
            let (chat, message) = (need(body, "chat")?, need(body, "text")?);
            let to = text(body, "to").filter(|t| !t.trim().is_empty()).unwrap_or(chat);
            if !confirm(manager, "Mimir wants to send a message", &format!("To: {to}\n\n{message}"), "Send") {
                return Err("You chose not to send it".into());
            }
            crate::imessage::query(manager, json!({ "op": "send", "chat": chat, "text": message }))
        }

        // ---- The other computers ----
        "/mimir/computers" => {
            let peers: Vec<(String, String, String, bool)> = {
                let runtime = manager.lock()?;
                runtime.paired.values().map(|p| (p.instance_id.clone(), p.name.clone(), p.platform.clone(), !p.mac_addresses.is_empty())).collect()
            };
            let list: Vec<Value> = peers
                .into_iter()
                .map(|(id, name, platform, wakeable)| match peer::fetch_status_value(manager, &id) {
                    Ok(status) => json!({ "name": name, "platform": platform, "online": true, "wakeable": wakeable, "version": status.get("version"), "hostname": status.get("hostname"), "uptimeSeconds": status.get("uptimeSeconds") }),
                    Err(_) => json!({ "name": name, "platform": platform, "online": false, "wakeable": wakeable }),
                })
                .collect();
            Ok(json!(list))
        }
        "/mimir/computers/wake" => {
            let id = peer_by_name(manager, need(body, "computer")?)?;
            let (name, macs, addresses) = {
                let runtime = manager.lock()?;
                let peer = runtime.paired.get(&id).ok_or("Paired computer not found")?;
                (peer.name.clone(), peer.mac_addresses.clone(), peer_addresses(&runtime, peer))
            };
            crate::wake::send(&macs, &addresses)?;
            Ok(json!(format!("Wake-up sent to {name}; it can take half a minute.")))
        }

        // ---- Files ----
        "/mimir/files/send" => {
            let id = peer_by_name(manager, need(body, "computer")?)?;
            let paths: Vec<std::path::PathBuf> = body.get("paths").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|p| p.as_str().map(std::path::PathBuf::from)).collect()).unwrap_or_default();
            let sources = crate::transfer::expand(&paths)?;
            let name = peer::paired_peers(manager).into_iter().find(|(pid, _)| pid == &id).map(|(_, n)| n).unwrap_or_default();
            let list = sources.iter().take(8).map(|(_, rel)| format!("• {rel}")).collect::<Vec<_>>().join("\n");
            let more = if sources.len() > 8 { format!("\n…and {} more", sources.len() - 8) } else { String::new() };
            if !confirm(manager, "Mimir wants to send files", &format!("To {name}:\n{list}{more}"), "Send") {
                return Err("You chose not to send them".into());
            }
            Ok(json!({ "transfer": crate::transfer::start_send(manager.clone(), id, sources, None)? }))
        }
        "/mimir/files/status" => {
            let id = need(body, "id")?;
            Ok(json!(crate::transfer::transfers_list().into_iter().find(|t| t.id == id)))
        }

        // ---- Clipboard (shared with the paired computers when clipboard sharing is on) ----
        "/mimir/clipboard/get" => {
            let mut board = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            Ok(json!(board.get_text().unwrap_or_default()))
        }
        "/mimir/clipboard/set" => {
            let value = need(body, "text")?;
            let mut board = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            board.set_text(value.to_string()).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }

        // ---- AI rooms ----
        "/mimir/ai/rooms" => {
            let runtime = manager.lock()?;
            let state = runtime.workspace.state(now_ms());
            Ok(serde_json::to_value(state).map_err(|e| e.to_string())?)
        }
        "/mimir/ai/post" => {
            let send = AiSendWire { author: "Mimir".into(), body: need(body, "text")?.into(), channel: None, reply_to: None, peer_instance_id: None, to: Vec::new(), room: text(body, "room").map(str::to_string) };
            Ok(serde_json::to_value(ai_send_internal(manager, send)?).map_err(|e| e.to_string())?)
        }
        _ => Err("Not found".into()),
    }
}

fn find_note(manager: &BridgeLinkManager, id: &str) -> Result<Note, String> {
    manager.lock()?.notes.list().into_iter().find(|n| n.id == id).ok_or("No such note".into())
}

fn peer_by_name(manager: &BridgeLinkManager, name: &str) -> Result<String, String> {
    let peers = peer::paired_peers(manager);
    let wanted = name.trim().to_lowercase();
    peers
        .iter()
        .find(|(id, n)| n.to_lowercase() == wanted || id == name)
        .or_else(|| peers.iter().find(|(_, n)| n.to_lowercase().contains(&wanted)))
        .or_else(|| (peers.len() == 1).then(|| &peers[0]))
        .map(|(id, _)| id.clone())
        .ok_or_else(|| format!("No paired computer called {name}"))
}

fn notes_change<T>(manager: &BridgeLinkManager, change: impl FnOnce(&mut notes::NoteStore, &str, u64) -> Result<T, String>) -> Result<T, String> {
    notes::local(manager, change)
}

fn calendar_change<T>(manager: &BridgeLinkManager, change: impl FnOnce(&mut calendar::CalendarStore, &str, u64) -> Result<T, String>) -> Result<T, String> {
    calendar::local(manager, change)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn call(manager: &BridgeLinkManager, path: &str, body: Value) -> Value {
        let (status, text) = route(manager, path, &body.to_string());
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(status, 200, "{path}: {value}");
        value["result"].clone()
    }

    #[test]
    fn mimir_can_keep_notes_checklists_memory_and_calendar() {
        let manager = BridgeLinkManager::default();
        manager.lock().unwrap().instance_id = "mac".into();
        let id = call(&manager, "/mimir/notes/create", json!({ "title": "Thesis", "kind": "list", "folder": "School", "markdown": "- [ ] Ch 11\n  - [ ] Ch 11.1\n- [ ] Ch 12" }))["id"].as_str().unwrap().to_string();
        let found = call(&manager, "/mimir/notes/search", json!({ "query": "thesis 11.1" }));
        assert_eq!(found[0]["id"], id.as_str());
        assert_eq!(call(&manager, "/mimir/checklist/set", json!({ "id": id, "item": "Ch 11", "done": true }))["changed"], 2);
        let read = call(&manager, "/mimir/notes/read", json!({ "id": id }));
        assert_eq!(read["markdown"], "- [x] Ch 11\n  - [x] Ch 11.1\n- [ ] Ch 12");
        call(&manager, "/mimir/notes/append", json!({ "id": id, "markdown": "- [ ] Ch 13" }));
        // Memory: one fixed note, replaced as a whole.
        call(&manager, "/mimir/notes/create", json!({ "id": MEMORY_NOTE_ID, "title": "Mimir's memory", "markdown": "Likes tea" }));
        call(&manager, "/mimir/notes/replace", json!({ "id": MEMORY_NOTE_ID, "markdown": "Likes coffee now" }));
        assert_eq!(call(&manager, "/mimir/notes/read", json!({ "id": MEMORY_NOTE_ID }))["markdown"], "Likes coffee now");
        // Calendar.
        let event = call(&manager, "/mimir/calendar/add", json!({ "title": "Defense", "start": 1_000, "end": 2_000 }));
        assert_eq!(event["color"], "purple");
        assert_eq!(call(&manager, "/mimir/calendar/events", json!({})).as_array().unwrap().len(), 1);
        assert_eq!(call(&manager, "/mimir/calendar/delete", json!({ "id": event["id"] })), true);
        // Outward actions need a person to confirm; with no window to ask in, they're refused.
        let (status, text) = route(&manager, "/mimir/messages/send", &json!({ "chat": "x", "text": "hi" }).to_string());
        assert_eq!(status, 409, "{text}");
        assert_eq!(route(&manager, "/mimir/nope", "{}").0, 404);
    }
}
