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

// ---- Activity log: what Mimir changed or sent, shown in Settings → Mimir ----

const ACTIVITY_FILE: &str = "mimir-activity.json";
const ACTIVITY_KEEP: usize = 300;
static ACTIVITY: std::sync::Mutex<Option<std::collections::VecDeque<Activity>>> = std::sync::Mutex::new(None);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub at: u64,
    pub action: String,
    pub detail: String,
    pub ok: bool,
    /// Leaves this computer for someone or somewhere else (a message, files); always asked first.
    pub outward: bool,
}

/// What a route does, for the log; reading routes aren't logged.
fn describe(path: &str) -> Option<(&'static str, bool)> {
    Some(match path {
        "/mimir/notes/create" => ("Made a note", false),
        "/mimir/notes/append" => ("Added to a note", false),
        "/mimir/notes/replace" => ("Rewrote a note", false),
        "/mimir/checklist/set" => ("Ticked a checklist item", false),
        "/mimir/calendar/add" => ("Added a calendar event", false),
        "/mimir/calendar/delete" => ("Deleted a calendar event", false),
        "/mimir/messages/send" => ("Sent a message", true),
        "/mimir/computers/wake" => ("Woke a computer", false),
        "/mimir/files/send" => ("Sent files", true),
        "/mimir/computers/look" => ("Looked at a computer's screen", false),
        "/mimir/clipboard/set" => ("Set the clipboard", false),
        "/mimir/ai/post" => ("Posted in an AI room", false),
        "/mimir/study/flashcards/add" => ("Added flashcards", false),
        "/mimir/projects/task/add" => ("Added a project task", false),
        "/mimir/projects/task/move" => ("Moved a project task", false),
        _ => return None,
    })
}

fn activity_detail(path: &str, body: &Value) -> String {
    let pick = |keys: &[&str]| keys.iter().find_map(|k| body.get(*k).and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty()).map(str::to_string));
    let text = match path {
        "/mimir/messages/send" => format!("To {}: {}", pick(&["to", "chat"]).unwrap_or_default(), pick(&["text"]).unwrap_or_default()),
        "/mimir/files/send" => format!("To {}: {}", pick(&["computer"]).unwrap_or_default(), body.get("paths").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|p| p.as_str()).map(|p| p.rsplit(['/', '\\']).next().unwrap_or(p)).collect::<Vec<_>>().join(", ")).unwrap_or_default()),
        "/mimir/projects/task/add" | "/mimir/projects/task/move" => format!("{}: {}{}", pick(&["project"]).unwrap_or_default(), pick(&["task"]).unwrap_or_default(), pick(&["column"]).map(|c| format!(" → {c}")).unwrap_or_default()),
        "/mimir/study/flashcards/add" => format!("{}: {} card(s)", pick(&["course"]).unwrap_or_default(), body.get("cards").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)),
        _ => pick(&["title", "item", "computer", "text", "markdown", "id"]).unwrap_or_default(),
    };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > 120 { format!("{}…", text.chars().take(120).collect::<String>()) } else { text }
}

fn log_activity(manager: &BridgeLinkManager, entry: Activity) {
    let dir = manager.lock().ok().and_then(|r| r.storage_dir.clone());
    let Ok(mut stored) = ACTIVITY.lock() else { return };
    let log = stored.get_or_insert_with(|| dir.as_ref().and_then(|d| load_json(&d.join(ACTIVITY_FILE))).unwrap_or_default());
    log.push_front(entry);
    log.truncate(ACTIVITY_KEEP);
    if let (Some(dir), Ok(raw)) = (dir, serde_json::to_string(&*log)) {
        let _ = secure_write(&dir.join(ACTIVITY_FILE), &raw);
    }
}

/// Mimir's recent actions, newest first.
#[tauri::command]
pub fn mimir_activity(manager: tauri::State<'_, BridgeLinkManager>) -> Vec<Activity> {
    let dir = manager.lock().ok().and_then(|r| r.storage_dir.clone());
    let Ok(mut stored) = ACTIVITY.lock() else { return Vec::new() };
    stored.get_or_insert_with(|| dir.as_ref().and_then(|d| load_json(&d.join(ACTIVITY_FILE))).unwrap_or_default()).iter().cloned().collect()
}

pub(super) fn route(manager: &BridgeLinkManager, path: &str, body: &str) -> (u16, String) {
    let body: Value = if body.trim().is_empty() { json!({}) } else {
        match serde_json::from_str(body) {
            Ok(value) => value,
            Err(_) => return (400, r#"{"ok":false,"error":"Expected a JSON body"}"#.into()),
        }
    };
    let result = handle(manager, path, &body);
    if let Some((action, outward)) = describe(path) {
        let detail = match &result {
            Ok(_) => activity_detail(path, &body),
            Err(error) => format!("{} — not done: {error}", activity_detail(path, &body)),
        };
        log_activity(manager, Activity { at: now_ms(), action: action.into(), detail, ok: result.is_ok(), outward });
    }
    match result {
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

        "/mimir/notes/due" => {
            let notes = manager.lock()?.notes.list();
            let mut due: Vec<Value> = notes
                .iter()
                .filter(|n| !n.deleted)
                .flat_map(|n| n.blocks.iter().filter(|b| !b.deleted && b.kind == "todo" && !b.checked && b.due.is_some()).map(move |b| json!({ "note": notes::display_title(n), "noteId": n.id, "text": b.text, "due": b.due })))
                .collect();
            due.sort_by_key(|d| d["due"].as_u64().unwrap_or(0));
            Ok(json!(due))
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

        "/mimir/computers/look" => {
            let id = peer_by_name(manager, need(body, "computer")?)?;
            let name = peer::paired_peers(manager).into_iter().find(|(pid, _)| pid == &id).map(|(_, n)| n).unwrap_or_default();
            let monitor = body.get("monitor").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let app = manager.lock()?.app.clone();
            crate::remote::mimir::look(manager, app.as_ref(), &id, &name, monitor)
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

        // ---- Study: the user's textbooks, searched by page ----
        "/mimir/study/courses" => {
            let (library, dir) = crate::study::library_for_search()?;
            let all_notes = manager.lock()?.notes.list();
            let courses: Vec<Value> = library
                .courses
                .iter()
                .map(|c| {
                    let folder = study_folder(&c.name).to_lowercase();
                    let mine: Vec<&Note> = all_notes.iter().filter(|n| !n.deleted && n.folder.to_lowercase() == folder).collect();
                    let cards = mine.iter().filter(|n| is_card_note(n)).flat_map(|n| n.blocks.iter().filter(|b| !b.deleted && card_parts(&b.text).is_some())).collect::<Vec<_>>();
                    let due = cards.iter().filter(|b| card_due(&b.text).is_none_or(|d| d <= now_ms())).count();
                    json!({
                        "name": c.name,
                        "books": c.books.iter().map(|b| json!({ "title": b.title, "file": b.file, "kind": b.kind, "searchable": b.indexed, "pages": crate::study::load_text(&dir, &c.name, &b.file).map(|t| t.pages.len()) })).collect::<Vec<_>>(),
                        "notes": mine.iter().map(|n| json!({ "id": n.id, "title": notes::display_title(n), "kind": n.kind })).collect::<Vec<_>>(),
                        "flashcards": cards.len(),
                        "flashcardsDue": due,
                    })
                })
                .collect();
            Ok(json!({ "root": library.root, "courses": courses }))
        }
        "/mimir/study/search" => {
            let (library, dir) = crate::study::library_for_search()?;
            let limit = body.get("limit").and_then(|v| v.as_u64()).unwrap_or(8).clamp(1, 30) as usize;
            let hits = crate::study::search(&library, &dir, need(body, "query")?, text(body, "course"), limit);
            Ok(json!(hits.into_iter().map(|h| { let link = book_link(&h.course, &h.file, h.page); json!({ "course": h.course, "book": h.book, "file": h.file, "page": h.page, "text": h.snippet, "link": link }) }).collect::<Vec<_>>()))
        }
        "/mimir/study/read" => {
            let (library, dir) = crate::study::library_for_search()?;
            let course = crate::study::find_course(&library, need(body, "course")?).ok_or("No such course")?;
            let book = crate::study::find_book(course, need(body, "book")?).ok_or("No such book in that course")?;
            let book_text = crate::study::load_text(&dir, &course.name, &book.file).ok_or("That book isn't searchable yet; open the Study tab so BridgeDeck can read it")?;
            let total = book_text.pages.len();
            let from = body.get("from").and_then(|v| v.as_u64()).unwrap_or(1).max(1) as usize;
            let to = body.get("to").and_then(|v| v.as_u64()).map(|t| t as usize).unwrap_or(from).max(from).min(from + 7).min(total);
            if from > total {
                return Err(format!("The book has {total} pages"));
            }
            let pages: Vec<Value> = (from..=to).map(|p| json!({ "page": p, "text": book_text.pages[p - 1], "link": book_link(&course.name, &book.file, p) })).collect();
            Ok(json!({ "course": course.name, "book": book.title, "pages": total, "read": pages }))
        }
        "/mimir/study/flashcards/add" => {
            let library = crate::study::read_library(&crate::study::root_or_default())?;
            let course = crate::study::find_course(&library, need(body, "course")?).ok_or("No such course")?.clone();
            let cards = body.get("cards").and_then(|v| v.as_array()).ok_or("`cards` is required")?;
            let one_line = |v: Option<&str>| v.unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ").replace(" :: ", " : ");
            let mut lines = Vec::new();
            for card in cards.iter().take(100) {
                let (front, back) = (one_line(card.get("front").and_then(|v| v.as_str())), one_line(card.get("back").and_then(|v| v.as_str())));
                if front.is_empty() || back.is_empty() {
                    continue;
                }
                let source = match (card.get("book").and_then(|v| v.as_str()).and_then(|b| crate::study::find_book(&course, b)), card.get("page").and_then(|v| v.as_u64())) {
                    (Some(book), Some(page)) => format!(" ([{}, p. {page}]({}))", book.title, book_link(&course.name, &book.file, page as usize)),
                    _ => String::new(),
                };
                lines.push(format!("- {front} :: {back}{source}"));
            }
            if lines.is_empty() {
                return Err("Each card needs a front and a back".into());
            }
            let (title, folder, markdown, count) = (format!("{} — flashcards", course.name), study_folder(&course.name), lines.join("\n"), lines.len());
            let note = notes_change(manager, move |store, device, now| {
                let existing = store.list().into_iter().find(|n| !n.deleted && n.title == title && n.folder.eq_ignore_ascii_case(&folder)).map(|n| n.id);
                match existing {
                    Some(id) => store.append_markdown(&id, &markdown, device, now),
                    None => store.create_from_markdown(None, "note", &title, &folder, &markdown, device, now),
                }
            })?;
            Ok(json!({ "id": note.id, "added": count }))
        }

        // ---- Projects: folders, task boards and milestones ----
        "/mimir/projects/list" => {
            let root = crate::projects::root_or_default();
            let listed = crate::projects::list(&root, &root)?;
            let (all_notes, events) = { let r = manager.lock()?; (r.notes.list(), r.calendar.list()) };
            let now = now_ms();
            let projects: Vec<Value> = listed
                .projects
                .iter()
                .map(|p| {
                    let folder = project_folder(&p.name).to_lowercase();
                    let mine: Vec<&Note> = all_notes.iter().filter(|n| !n.deleted && n.folder.to_lowercase() == folder).collect();
                    let board = mine.iter().find(|n| n.title == board_title(&p.name)).map(|n| {
                        notes::board_columns(n).iter().map(|(h, cards)| json!({ "column": h.as_ref().map(|h| h.text.clone()).unwrap_or_else(|| "To do".into()), "cards": cards.iter().filter(|b| b.indent == 0).map(|b| b.text.clone()).collect::<Vec<_>>() })).collect::<Vec<_>>()
                    });
                    let name = p.name.to_lowercase();
                    let milestones: Vec<Value> = events.iter().filter(|e| !e.deleted && e.end >= now as i64 && e.title.to_lowercase().contains(&name)).map(|e| json!({ "title": e.title, "start": e.start, "id": e.id })).collect();
                    json!({ "name": p.name, "folder": root.join(&p.name).to_string_lossy(), "files": p.files, "notes": mine.iter().map(|n| json!({ "id": n.id, "title": notes::display_title(n), "kind": n.kind })).collect::<Vec<_>>(), "board": board, "milestones": milestones })
                })
                .collect();
            Ok(json!({ "root": listed.root, "projects": projects }))
        }
        "/mimir/projects/task/add" | "/mimir/projects/task/move" => {
            let root = crate::projects::root_or_default();
            let wanted = need(body, "project")?.to_lowercase();
            let names: Vec<String> = crate::projects::list(&root, &root)?.projects.into_iter().map(|p| p.name).collect();
            let project = names.iter().find(|n| n.to_lowercase() == wanted).or_else(|| names.iter().find(|n| n.to_lowercase().contains(&wanted))).ok_or("No such project")?.clone();
            let (title, folder) = (board_title(&project), project_folder(&project));
            let task = need(body, "task")?.to_string();
            let column = text(body, "column").map(str::to_string);
            let due = body.get("due").and_then(|v| v.as_u64());
            let moving = path.ends_with("move");
            let note = notes_change(manager, move |store, device, now| {
                let id = match store.list().into_iter().find(|n| !n.deleted && n.title == title && n.folder.eq_ignore_ascii_case(&folder)) {
                    Some(note) => note.id,
                    None if moving => return Err("That project has no board yet".into()),
                    None => store.create_from_markdown(None, "list", &title, &folder, &notes::BOARD_COLUMNS.map(|c| format!("## {c}")).join("\n\n"), device, now)?.id,
                };
                if moving {
                    store.board_move(&id, &task, column.as_deref().ok_or("`column` is required")?, device, now)
                } else {
                    store.board_add(&id, column.as_deref(), &task, due, device, now)
                }
            })?;
            Ok(json!({ "id": note.id, "markdown": notes::to_markdown(&note) }))
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

fn project_folder(project: &str) -> String {
    format!("Projects/{project}")
}

/// A project's task board note (see `notes::board_columns`).
fn board_title(project: &str) -> String {
    format!("{project} — board")
}

fn study_folder(course: &str) -> String {
    format!("Study/{course}")
}

/// `book:<course>/<file>#<page>`, as the Notes tab opens it (see study/model.ts).
fn book_link(course: &str, file: &str, page: usize) -> String {
    let encode = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    format!("book:{}/{}#{page}", encode(course), encode(file))
}

/// Flashcards live in notes whose title says so; each card is a line `front :: back`.
fn is_card_note(note: &Note) -> bool {
    note.title.to_lowercase().contains("flashcards")
}

fn card_parts(text: &str) -> Option<(&str, &str)> {
    let body = text.split("<!--").next().unwrap_or(text);
    body.split_once(" :: ").filter(|(f, b)| !f.trim().is_empty() && !b.trim().is_empty())
}

/// When a card is next due, from its review state `<!--fsrs due=… -->`; never reviewed has none.
fn card_due(text: &str) -> Option<u64> {
    let state = text.split("<!--fsrs ").nth(1)?;
    state.split_whitespace().find_map(|kv| kv.strip_prefix("due=")).and_then(|v| v.trim_end_matches("-->").parse().ok())
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
        // What Mimir changed is in the activity log, newest first; reading isn't logged.
        let log = ACTIVITY.lock().unwrap().clone().unwrap();
        let mine: Vec<&Activity> = log.iter().filter(|a| a.detail.contains("Thesis") || a.detail.contains("Defense") || a.detail.contains("To x")).collect();
        assert!(mine.iter().any(|a| a.action == "Made a note" && a.detail == "Thesis" && a.ok));
        assert!(mine.iter().any(|a| a.action == "Added a calendar event" && a.detail == "Defense"));
        let sent = mine.iter().find(|a| a.action == "Sent a message").unwrap();
        assert!(sent.outward && !sent.ok && sent.detail.starts_with("To x: hi — not done"), "{sent:?}");
        assert!(!log.iter().any(|a| a.action.contains("search")));
        let due = call(&manager, "/mimir/notes/due", json!({}));
        assert!(due.as_array().unwrap().is_empty());
    }

    #[test]
    fn mimir_searches_reads_and_makes_flashcards_from_the_users_books() {
        let base = std::env::temp_dir().join(format!("bd-mimir-study-{}", Uuid::new_v4()));
        let course_dir = base.join("Study").join("Math 221");
        std::fs::create_dir_all(&course_dir).unwrap();
        std::fs::write(course_dir.join("Calculus (8th ed).pdf"), b"%PDF").unwrap();
        crate::study::set_index_dir(base.join("index"));
        crate::study::study_library(base.to_string_lossy().to_string()).unwrap();
        let pages = vec!["Limits and continuity.".to_string(), "The chain rule differentiates compositions.".to_string(), "Integrals.".to_string()];
        crate::study::save_text(&base.join("index"), "Math 221", "Calculus (8th ed).pdf", &crate::study::BookText { bytes: 4, pages, version: crate::study::INDEX_VERSION }).unwrap();

        let manager = BridgeLinkManager::default();
        manager.lock().unwrap().instance_id = "mac".into();
        let hits = call(&manager, "/mimir/study/search", json!({ "query": "chain rule", "course": "math" }));
        assert_eq!(hits[0]["page"], 2);
        assert_eq!(hits[0]["link"], "book:Math%20221/Calculus%20%288th%20ed%29.pdf#2");
        let read = call(&manager, "/mimir/study/read", json!({ "course": "math 221", "book": "calculus", "from": 2, "to": 40 }));
        assert_eq!(read["read"].as_array().unwrap().len(), 2, "stops at the last page");
        assert_eq!(read["pages"], 3);
        let added = call(&manager, "/mimir/study/flashcards/add", json!({ "course": "Math 221", "cards": [
            { "front": "Chain rule?", "back": "f'(g(x)) g'(x)", "book": "Calculus", "page": 2 },
            { "front": "Empty back", "back": " " },
        ] }));
        assert_eq!(added["added"], 1);
        call(&manager, "/mimir/study/flashcards/add", json!({ "course": "math", "cards": [{ "front": "Limit?", "back": "What f approaches" }] }));
        let deck = call(&manager, "/mimir/notes/read", json!({ "id": added["id"] }));
        assert_eq!(deck["title"], "Math 221 — flashcards");
        assert_eq!(deck["folder"], "Study/Math 221");
        assert_eq!(deck["markdown"], "- Chain rule? :: f'(g(x)) g'(x) ([Calculus (8th ed), p. 2](book:Math%20221/Calculus%20%288th%20ed%29.pdf#2))\n- Limit? :: What f approaches");
        let courses = call(&manager, "/mimir/study/courses", json!({}));
        assert_eq!(courses["courses"][0]["flashcards"], 2);
        assert_eq!(courses["courses"][0]["flashcardsDue"], 2);
        assert_eq!(courses["courses"][0]["books"][0]["searchable"], true);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn mimir_keeps_a_projects_task_board() {
        let manager = BridgeLinkManager::default();
        manager.lock().unwrap().instance_id = "mac".into();
        let root = crate::projects::root_or_default();
        let name = format!("BD test {}", Uuid::new_v4().simple());
        std::fs::create_dir_all(root.join(&name)).unwrap();
        let added = call(&manager, "/mimir/projects/task/add", json!({ "project": name.to_lowercase(), "task": "Order motors" }));
        call(&manager, "/mimir/projects/task/add", json!({ "project": name, "task": "Wire it", "column": "doing" }));
        let moved = call(&manager, "/mimir/projects/task/move", json!({ "project": name, "task": "order", "column": "done" }));
        assert_eq!(moved["id"], added["id"]);
        assert_eq!(moved["markdown"], "## To do\n\n## Doing\n\n- [ ] Wire it\n\n## Done\n\n- [x] Order motors");
        let listed = call(&manager, "/mimir/projects/list", json!({}));
        let mine = listed["projects"].as_array().unwrap().iter().find(|p| p["name"] == name.as_str()).unwrap().clone();
        assert_eq!(mine["board"][2], json!({ "column": "Done", "cards": ["Order motors"] }));
        let _ = std::fs::remove_dir_all(root.join(&name));
    }

    #[test]
    fn flashcards_and_book_links_match_the_study_tab() {
        assert_eq!(book_link("Math 221", "Calculus (8th ed).pdf", 4), "book:Math%20221/Calculus%20%288th%20ed%29.pdf#4");
        assert_eq!(card_parts("What is ATP? :: The cell's energy currency <!--fsrs due=5 s=1-->"), Some(("What is ATP?", "The cell's energy currency ")));
        assert_eq!(card_parts("No card here"), None);
        assert_eq!(card_due("Q :: A <!--fsrs due=1700000000000 s=2.1 d=5-->"), Some(1_700_000_000_000));
        assert_eq!(card_due("Q :: A"), None);
    }
}
