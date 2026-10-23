//! The phone page: a small web page any phone on the same Wi-Fi can open (no app needed) to send
//! text, links and files to this computer, see today's agenda and what's due, and tick checklists.
//!
//! It's off until turned on in Settings. It listens on the local network (port 41420) and every
//! request but the page itself needs the key that's in the link (and the QR code) shown in Settings;
//! a new key can be made at any time, which locks out phones that had the old one.

use crate::bridgelink::BridgeLinkManager;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

const PORT: u16 = 41420;
const PAGE: &str = include_str!("phone.html");
const INK_PAGE: &str = include_str!("ink.html");
const MAX_JSON: usize = 256 * 1024;
const MAX_UPLOAD: u64 = 500 * 1024 * 1024;
const KEY_FILE: &str = "phone-key";

struct Server {
    stop: Arc<AtomicBool>,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);
static ERROR: Mutex<String> = Mutex::new(String::new());
/// Whether the page may be opened over Tailscale (from the phone on campus); off unless chosen.
static TAILSCALE: AtomicBool = AtomicBool::new(false);
/// Today's agenda and what's due, as the window last worked it out (it knows recurring events and
/// Canvas); the page shows it as is.
static SNAPSHOT: Mutex<Option<Value>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    pub running: bool,
    /// The page's address with its key, for each of this computer's network addresses.
    pub urls: Vec<String>,
    pub error: String,
}

fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(KEY_FILE))
}

fn new_key() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 18];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn key(app: &AppHandle) -> Result<String, String> {
    let path = key_path(app)?;
    if let Ok(text) = std::fs::read_to_string(&path) {
        let text = text.trim().to_string();
        if text.len() >= 24 && text.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(text);
        }
    }
    let key = new_key();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, &key).map_err(|e| e.to_string())?;
    Ok(key)
}

/// This computer's address on the local network (the one it would use to reach the internet; no
/// packet is sent).
fn lan_address() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    socket.local_addr().ok().map(|a| a.ip()).filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
}

/// Tailscale's addresses (100.64.0.0/10).
pub fn is_tailscale(ip: &std::net::IpAddr) -> bool {
    matches!(ip, std::net::IpAddr::V4(v4) if v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
}

/// This computer's Tailscale address, if Tailscale is on: the address it would use to reach
/// Tailscale's own DNS (no packet is sent).
fn tailscale_address() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("100.100.100.100:53").ok()?;
    socket.local_addr().ok().map(|a| a.ip()).filter(is_tailscale)
}

fn status(app: &AppHandle) -> PhoneStatus {
    let running = SERVER.lock().map(|s| s.is_some()).unwrap_or(false);
    let urls = match (running, key(app)) {
        (true, Ok(key)) => {
            let mut urls: Vec<String> = lan_address().filter(|ip| !is_tailscale(ip)).map(|ip| vec![format!("http://{ip}:{PORT}/#{key}")]).unwrap_or_default();
            if TAILSCALE.load(Ordering::Relaxed) {
                urls.extend(tailscale_address().map(|ip| format!("http://{ip}:{PORT}/#{key}")));
            }
            urls
        }
        _ => Vec::new(),
    };
    PhoneStatus { running, urls, error: ERROR.lock().map(|e| e.clone()).unwrap_or_default() }
}

fn start(app: &AppHandle) -> Result<(), String> {
    let mut server = SERVER.lock().map_err(|_| "lock poisoned")?;
    if server.is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind(("0.0.0.0", PORT)).map_err(|e| format!("Port {PORT} is in use or blocked: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let (app, flag) = (app.clone(), stop.clone());
    std::thread::Builder::new()
        .name("phone-page".into())
        .spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, addr)) => {
                        let app = app.clone();
                        std::thread::spawn(move || handle(&app, stream, addr));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(80)),
                    Err(_) => std::thread::sleep(Duration::from_millis(200)),
                }
            }
        })
        .map_err(|e| e.to_string())?;
    *server = Some(Server { stop });
    Ok(())
}

fn stop() {
    if let Ok(mut server) = SERVER.lock() {
        if let Some(s) = server.take() {
            s.stop.store(true, Ordering::Relaxed);
        }
    }
}

// ---- HTTP ----

struct Request {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    /// What was read past the headers (the start of the body).
    rest: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    fn length(&self) -> u64 {
        self.header("content-length").and_then(|v| v.trim().parse().ok()).unwrap_or(0)
    }
    fn param(&self, name: &str) -> Option<String> {
        url::form_urlencoded::parse(self.query.as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
    }
}

fn read_head(stream: &mut TcpStream) -> Result<Request, String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let end = loop {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("closed".into());
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(i) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buffer.len() > 32 * 1024 {
            return Err("headers too large".into());
        }
    };
    let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let method = first.next().unwrap_or_default().to_string();
    let target = first.next().unwrap_or("/").to_string();
    let (path, query) = target.split_once('?').map(|(p, q)| (p.to_string(), q.to_string())).unwrap_or((target, String::new()));
    let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    Ok(Request { method, path, query, headers, rest: buffer[end + 4..].to_vec() })
}

fn read_body(stream: &mut TcpStream, request: &Request, max: usize) -> Result<Vec<u8>, String> {
    let length = request.length() as usize;
    if length > max {
        return Err("too large".into());
    }
    let mut body = request.rest.clone();
    body.truncate(length);
    let mut chunk = [0u8; 16384];
    while body.len() < length {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n.min(length - body.len())]);
    }
    Ok(body)
}

fn respond(stream: &mut TcpStream, status: u16, kind: &str, body: &[u8]) {
    let label = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {label}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

fn json_reply(stream: &mut TcpStream, status: u16, value: &Value) {
    respond(stream, status, "application/json", value.to_string().as_bytes());
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle(app: &AppHandle, mut stream: TcpStream, addr: SocketAddr) {
    // Over Tailscale only when it's been turned on.
    if is_tailscale(&addr.ip()) && !TAILSCALE.load(Ordering::Relaxed) {
        return;
    }
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let Ok(request) = read_head(&mut stream) else { return };
    if request.method == "GET" && (request.path == "/" || request.path == "/index.html") {
        return respond(&mut stream, 200, "text/html; charset=utf-8", PAGE.as_bytes());
    }
    if request.method == "GET" && request.path == "/ink" {
        return respond(&mut stream, 200, "text/html; charset=utf-8", INK_PAGE.as_bytes());
    }
    if !request.path.starts_with("/api/") {
        return respond(&mut stream, 404, "text/plain", b"Not found");
    }
    let authorized = key(app).is_ok_and(|key| request.header("x-key").is_some_and(|given| same(given, &key)));
    if !authorized {
        // Slows down guessing.
        std::thread::sleep(Duration::from_millis(400));
        return json_reply(&mut stream, 401, &json!({ "error": "This link is old. Open the new one from BridgeDeck → Settings → Phone." }));
    }
    let result = route(app, &mut stream, &request);
    match result {
        Ok(value) => json_reply(&mut stream, 200, &value),
        Err(error) => json_reply(&mut stream, 400, &json!({ "error": error })),
    }
}

fn route(app: &AppHandle, stream: &mut TcpStream, request: &Request) -> Result<Value, String> {
    let manager = app.state::<BridgeLinkManager>().inner().clone();
    let body_json = |stream: &mut TcpStream| -> Result<Value, String> { serde_json::from_slice(&read_body(stream, request, MAX_JSON)?).map_err(|_| "Bad request".to_string()) };
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/summary") => {
            let computer = manager.computer_name();
            let snapshot = SNAPSHOT.lock().ok().and_then(|s| s.clone()).unwrap_or(json!({}));
            Ok(json!({ "computer": computer, "snapshot": snapshot, "lists": crate::bridgelink::notes::phone_lists(&manager)?, "courses": crate::study::course_names() }))
        }
        ("POST", "/api/check") => {
            let body = body_json(stream)?;
            let (note, block, checked) = (body["note"].as_str().unwrap_or_default(), body["block"].as_str().unwrap_or_default(), body["checked"].as_bool().unwrap_or(false));
            crate::bridgelink::notes::phone_check(&manager, note, block, checked)?;
            let _ = app.emit("notes-changed", ());
            Ok(json!({ "ok": true }))
        }
        ("POST", "/api/add") => {
            let body = body_json(stream)?;
            crate::bridgelink::notes::phone_add(&manager, body["note"].as_str().unwrap_or_default(), body["text"].as_str().unwrap_or_default())?;
            let _ = app.emit("notes-changed", ());
            Ok(json!({ "ok": true }))
        }
        ("POST", "/api/text") => {
            let body = body_json(stream)?;
            let text = body["text"].as_str().unwrap_or_default().trim().to_string();
            if text.is_empty() {
                return Err("Nothing to send".into());
            }
            crate::clipboard::put_text(text.clone()).ok();
            crate::clipboard::remember_from(&text, "Phone");
            let _ = app.emit("phone-text", json!({ "text": text }));
            Ok(json!({ "ok": true }))
        }
        ("POST", "/api/upload") => {
            let name = request.param("name").unwrap_or_default();
            let path = upload(app, stream, request, &name)?;
            let _ = app.emit("phone-file", json!({ "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), "path": path.display().to_string() }));
            Ok(json!({ "ok": true, "name": path.file_name().map(|n| n.to_string_lossy().to_string()) }))
        }
        // Homework scanned on the phone: each page as a JPEG, then "done" puts them in one PDF in
        // the course.
        ("POST", "/api/scan/page") => {
            let batch = scan_batch(request.param("batch").as_deref())?;
            let n: u32 = request.param("n").and_then(|n| n.parse().ok()).filter(|n| *n < MAX_SCAN_PAGES).ok_or("Bad page number")?;
            let bytes = read_body(stream, request, MAX_SCAN_PAGE)?;
            if crate::scan_pdf::jpeg_info(&bytes).is_none() {
                return Err("That page isn't a JPEG photo".into());
            }
            let dir = scans_dir(app)?.join(&batch);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(format!("{n:03}.jpg")), bytes).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        ("POST", "/api/scan/done") => {
            let body = body_json(stream)?;
            let batch = scan_batch(body["batch"].as_str())?;
            let (course, name) = (body["course"].as_str().unwrap_or_default(), body["name"].as_str().unwrap_or_default());
            let dir = scans_dir(app)?.join(&batch);
            let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).map_err(|_| "No pages were sent")?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "jpg")).collect();
            files.sort();
            let pages = files.iter().map(std::fs::read).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            let pdf = crate::scan_pdf::jpegs_to_pdf(&pages, name)?;
            let file = crate::study::save_pdf_in(course, if name.trim().is_empty() { "Scan" } else { name }, &pdf)?;
            let _ = std::fs::remove_dir_all(&dir);
            crate::activity::info("phone", &format!("Scanned {} page{} into {course}/{file}.", pages.len(), if pages.len() == 1 { "" } else { "s" }));
            let _ = app.emit("study-scan", json!({ "course": course, "file": file, "pages": pages.len() }));
            Ok(json!({ "ok": true, "file": file, "pages": pages.len() }))
        }
        // Flashcards reviewed on the phone (queued there while offline): the app applies them.
        ("POST", "/api/cards/review") => {
            let body = body_json(stream)?;
            let reviews: Vec<Value> = body["reviews"].as_array().ok_or("Bad request")?.iter().filter(|r| r["card"].is_string() && r["grade"].as_u64().is_some_and(|g| (1..=4).contains(&g)) && r["at"].is_u64()).take(500).cloned().collect();
            let _ = app.emit("phone-reviews", json!({ "reviews": reviews }));
            Ok(json!({ "ok": true, "received": reviews.len() }))
        }
        // Handwriting from the iPad (src-tauri/src/ink.rs): its strokes go to its own log.
        ("GET", "/api/ink/list") => Ok(json!({ "inks": crate::bridgelink::notes::phone_inks(&manager)?, "courses": crate::study::course_names() })),
        ("GET", "/api/ink/doc") => {
            let ink = crate::ink::load(&ink_dir(app, request)?);
            Ok(json!({ "doc": ink.doc, "logs": ink.logs, "backgrounds": ink.backgrounds }))
        }
        ("GET", "/api/ink/bg") => {
            use base64::Engine;
            let page: u32 = request.param("page").and_then(|p| p.parse().ok()).ok_or("Bad page")?;
            let png = std::fs::read(ink_dir(app, request)?.join("bg").join(format!("{page}.png"))).map_err(|_| "No background")?;
            Ok(json!({ "url": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)) }))
        }
        ("POST", "/api/ink/append") => {
            let dir = ink_dir(app, request)?;
            let body = body_json(stream)?;
            let lines: Vec<String> = body["lines"].as_array().ok_or("Bad request")?.iter().filter_map(|l| l.as_str().map(str::to_string)).collect();
            crate::ink::append(&dir, &phone_device(request)?, &lines)?;
            let _ = app.emit("ink-changed", json!({ "id": request.param("id") }));
            Ok(json!({ "ok": true }))
        }
        ("POST", "/api/ink/pages") => {
            let dir = ink_dir(app, request)?;
            let body = body_json(stream)?;
            let mut doc: Value = std::fs::read(dir.join("doc.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({ "v": 1, "paper": "lines", "size": "letter", "pages": 1 }));
            let pages = body["pages"].as_u64().filter(|p| (1..=2000).contains(p)).ok_or("Bad page count")?;
            if doc["pages"].as_u64().unwrap_or(1) < pages {
                doc["pages"] = json!(pages);
                crate::ink::set_doc(&dir, &doc.to_string())?;
            }
            Ok(json!({ "ok": true }))
        }
        ("POST", "/api/ink/new") => {
            let body = body_json(stream)?;
            let id = uuid::Uuid::new_v4().to_string();
            let shared = shared_root(app);
            let dir = crate::ink::folder_in(&shared, &id)?;
            crate::ink::set_doc(&dir, &json!({ "v": 1, "paper": body["paper"].as_str().filter(|p| ["lines", "grid", "dots", "blank"].contains(p)).unwrap_or("lines"), "size": "letter", "pages": 1 }).to_string())?;
            let course = body["course"].as_str().unwrap_or_default();
            let folder = if course.is_empty() { String::new() } else { format!("Study/{course}") };
            let title = body["title"].as_str().filter(|t| !t.trim().is_empty()).unwrap_or("Handwritten notes");
            crate::bridgelink::notes::phone_new_ink(&manager, title, &folder, &id)?;
            let _ = app.emit("notes-changed", ());
            Ok(json!({ "id": id }))
        }
        _ => Err("Unknown request".into()),
    }
}

fn shared_root(app: &AppHandle) -> PathBuf {
    let shared = crate::shared_folder(app);
    if shared.trim().is_empty() { crate::study::default_shared() } else { PathBuf::from(shared.trim()) }
}

fn ink_dir(app: &AppHandle, request: &Request) -> Result<PathBuf, String> {
    crate::ink::folder_in(&shared_root(app), &request.param("id").unwrap_or_default())
}

/// The iPad's (or phone's) own stroke log: `phone-<its id>` (hex, from the page).
fn phone_device(request: &Request) -> Result<String, String> {
    let d = request.param("d").unwrap_or_default();
    if (8..=32).contains(&d.len()) && d.chars().all(|c| c.is_ascii_hexdigit()) { Ok(format!("phone-{d}")) } else { Err("Bad device".into()) }
}

const MAX_SCAN_PAGE: usize = 30 * 1024 * 1024;
const MAX_SCAN_PAGES: u32 = 200;

/// A scan's id from the phone: hex, 8–64 characters (it names a folder).
fn scan_batch(batch: Option<&str>) -> Result<String, String> {
    batch.filter(|b| (8..=64).contains(&b.len()) && b.chars().all(|c| c.is_ascii_hexdigit())).map(str::to_string).ok_or_else(|| "Bad scan".into())
}

/// Where a scan's pages wait (on this computer only, not synced).
fn scans_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("phone-scans"))
}

/// A file name that's safe on Mac and Windows: no folders or reserved characters.
pub fn clean_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    let cleaned: String = cleaned.chars().take(120).collect();
    if cleaned.is_empty() { "From phone".into() } else { cleaned }
}

/// `name`, or "name (2).ext" and so on if it's taken.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..1000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

fn upload(app: &AppHandle, stream: &mut TcpStream, request: &Request, name: &str) -> Result<PathBuf, String> {
    let length = request.length();
    if length == 0 {
        return Err("The file is empty".into());
    }
    if length > MAX_UPLOAD {
        return Err("Files up to 500 MB can be sent this way".into());
    }
    let shared = crate::shared_folder(app);
    let root = if shared.trim().is_empty() { crate::study::default_shared() } else { PathBuf::from(shared.trim()) };
    save_upload(&root.join("From phone"), stream, request, name, length)
}

/// Streams the body to a new file in `dir` (complete files only: a broken upload leaves nothing).
fn save_upload(dir: &Path, stream: &mut TcpStream, request: &Request, name: &str, length: u64) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = free_path(dir, &clean_file_name(name));
    let partial = path.with_extension("partial-upload");
    let result = (|| {
        let mut file = std::fs::File::create(&partial).map_err(|e| e.to_string())?;
        let start = request.rest.len().min(length as usize);
        file.write_all(&request.rest[..start]).map_err(|e| e.to_string())?;
        let mut left = length - start as u64;
        let mut chunk = vec![0u8; 64 * 1024];
        while left > 0 {
            let n = stream.read(&mut chunk[..(left.min(64 * 1024) as usize)]).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("The upload stopped part way".to_string());
            }
            file.write_all(&chunk[..n]).map_err(|e| e.to_string())?;
            left -= n as u64;
        }
        file.flush().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&partial, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result.map(|_| path)
}

// ---- Commands ----

#[tauri::command]
pub fn phone_settings(app: AppHandle, enabled: bool, tailscale: Option<bool>) -> PhoneStatus {
    TAILSCALE.store(tailscale.unwrap_or(false), Ordering::Relaxed);
    let result = if enabled { start(&app) } else { stop(); Ok(()) };
    if let Ok(mut error) = ERROR.lock() {
        *error = result.err().unwrap_or_default();
    }
    status(&app)
}

#[tauri::command]
pub fn phone_status(app: AppHandle) -> PhoneStatus {
    status(&app)
}

/// A new key: phones with the old link have to scan the new one.
#[tauri::command]
pub fn phone_new_key(app: AppHandle) -> Result<PhoneStatus, String> {
    std::fs::write(key_path(&app)?, new_key()).map_err(|e| e.to_string())?;
    Ok(status(&app))
}

#[tauri::command]
pub fn phone_publish(snapshot: Value) {
    if snapshot.to_string().len() <= MAX_JSON {
        if let Ok(mut s) = SNAPSHOT.lock() {
            *s = Some(snapshot);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uploaded_names_stay_in_the_folder() {
        assert_eq!(clean_file_name("IMG_0042.HEIC"), "IMG_0042.HEIC");
        assert_eq!(clean_file_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_file_name("C:\\Users\\x\\photo.jpg"), "photo.jpg");
        assert_eq!(clean_file_name(".hidden"), "hidden");
        assert_eq!(clean_file_name("a<b>c?.txt"), "a_b_c_.txt");
        assert_eq!(clean_file_name(""), "From phone");
    }

    #[test]
    fn taken_names_get_a_number() {
        let dir = std::env::temp_dir().join(format!("bd-phone-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_path(&dir, "a.jpg"), dir.join("a.jpg"));
        std::fs::write(dir.join("a.jpg"), b"x").unwrap();
        assert_eq!(free_path(&dir, "a.jpg"), dir.join("a (2).jpg"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_requests_and_streams_uploads() {
        let dir = std::env::temp_dir().join(format!("bd-phone-upload-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let sent = body.clone();
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            let head = format!("POST /api/upload?name=..%2Fphoto%20one.jpg HTTP/1.1\r\nHost: x\r\nX-Key: abc\r\nContent-Length: {}\r\n\r\n", sent.len());
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(&sent).unwrap();
        });
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_head(&mut stream).unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str()), ("POST", "/api/upload"));
        assert_eq!(request.header("x-key"), Some("abc"));
        assert_eq!(request.param("name").as_deref(), Some("../photo one.jpg"));
        let path = save_upload(&dir, &mut stream, &request, &request.param("name").unwrap(), request.length()).unwrap();
        client.join().unwrap();
        assert_eq!(path, dir.join("photo one.jpg"));
        assert_eq!(std::fs::read(&path).unwrap(), body);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keys_compare_whole() {
        assert!(same("abc123", "abc123"));
        assert!(!same("abc123", "abc124") && !same("abc", "abc123"));
    }

    #[test]
    fn scan_ids_are_plain_hex() {
        assert_eq!(scan_batch(Some("a1b2c3d4e5f60718")).unwrap(), "a1b2c3d4e5f60718");
        for bad in [None, Some(""), Some("short"), Some("../../etc/xx"), Some("zzzzzzzzzz")] {
            assert!(scan_batch(bad).is_err());
        }
    }

    #[test]
    fn tailscale_addresses_are_known() {
        assert!(is_tailscale(&"100.101.5.7".parse().unwrap()));
        assert!(!is_tailscale(&"100.200.5.7".parse().unwrap()));
        assert!(!is_tailscale(&"192.168.1.20".parse().unwrap()));
    }
}