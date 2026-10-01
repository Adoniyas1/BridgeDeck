//! The loopback HTTP API: this computer's AI tools (`agent/ai-relay.mjs`, the Claude Code hook) and
//! BridgeDeck's own status. It listens on 127.0.0.1 only; paired devices use the encrypted link.
//!
//! Browsers can reach 127.0.0.1 too, so requests that carry an `Origin` header are refused unless the
//! origin is BridgeDeck's own WebView (or the Vite dev server), and CORS is granted only to those.

use super::*;
use std::{
    collections::HashMap,
    io::Read,
    net::{SocketAddr, TcpListener, TcpStream},
};

/// Large enough for a note (Mimir sends whole notes, its memory included).
const MAX_HTTP_BYTES: usize = 512 * 1024;

/// Origins of BridgeDeck's own WebView on each platform, and the dev server.
const ALLOWED_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"];

pub(super) fn origin_allowed(origin: Option<&str>) -> bool {
    origin.is_none_or(|origin| ALLOWED_ORIGINS.contains(&origin))
}

pub(super) fn bind(port: u16) -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("Could not bind the local BridgeDeck API on 127.0.0.1:{port}: {e}"))
}

pub(super) fn spawn(listener: TcpListener, manager: BridgeLinkManager, shutdown: Arc<AtomicBool>) {
    thread::spawn(move || {
        let _ = listener.set_nonblocking(true);
        while !shutdown.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, addr)) => {
                    let manager = manager.clone();
                    thread::spawn(move || handle(stream, addr, manager));
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(80)),
                Err(_) => thread::sleep(Duration::from_millis(150)),
            }
        }
    });
}

struct HttpRequest {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: String,
}

fn write_http(stream: &mut TcpStream, status: u16, body: &str, origin: Option<&str>) {
    let label = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let cors = match origin.filter(|o| ALLOWED_ORIGINS.contains(o)) {
        Some(origin) => format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n"),
        None => String::new(),
    };
    let response = format!(
        "HTTP/1.1 {status} {label}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cors}Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = std::io::Write::write_all(stream, response.as_bytes());
}

fn read_http(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    let mut temp = [0u8; 4096];
    let mut header_end = None;
    let mut content_len = 0usize;
    loop {
        let count = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..count]);
        if buffer.len() > MAX_HTTP_BYTES {
            return Err("Request too large".into());
        }
        if header_end.is_none() {
            if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
                for line in String::from_utf8_lossy(&buffer[..pos]).lines().skip(1) {
                    if let Some((name, value)) = line.split_once(':') {
                        if name.trim().eq_ignore_ascii_case("content-length") {
                            content_len = value.trim().parse().unwrap_or(0);
                        }
                    }
                }
            }
        }
        if header_end.is_some_and(|end| buffer.len() >= end + content_len) {
            break;
        }
    }
    let end = header_end.ok_or("Invalid HTTP request")?;
    let head = String::from_utf8(buffer[..end].to_vec()).map_err(|e| e.to_string())?;
    let body = String::from_utf8(buffer[end..].to_vec()).map_err(|e| e.to_string())?;
    let mut lines = head.lines();
    let mut parts = lines.next().ok_or("Missing request line")?.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    Ok(HttpRequest { method, target, headers, body })
}

fn query_value(target: &str, key: &str) -> Option<String> {
    target.split_once('?')?.1.split('&').find_map(|part| {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        (name == key).then(|| value.to_string())
    })
}

fn bearer(headers: &HashMap<String, String>) -> Option<&str> {
    headers.get("authorization").and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
}

fn handle(mut stream: TcpStream, addr: SocketAddr, manager: BridgeLinkManager) {
    // The listener is non-blocking and macOS (BSD) sockets inherit that on accept.
    let _ = stream.set_nonblocking(false);
    if !addr.ip().is_loopback() {
        return;
    }
    let request = match read_http(&mut stream) {
        Ok(request) => request,
        Err(error) => return write_http(&mut stream, 400, &serde_json::json!({ "error": error }).to_string(), None),
    };
    let origin = request.headers.get("origin").map(String::as_str);
    if !origin_allowed(origin) {
        return write_http(&mut stream, 403, r#"{"ok":false,"error":"Origin not allowed"}"#, None);
    }
    if request.method == "OPTIONS" {
        return write_http(&mut stream, 204, "", origin);
    }
    let path = request.target.split('?').next().unwrap_or(&request.target).to_string();
    let (status, body) = route(&manager, &request, &path);
    write_http(&mut stream, status, &body, origin);
}

fn route(manager: &BridgeLinkManager, request: &HttpRequest, path: &str) -> (u16, String) {
    let Ok(runtime) = manager.lock() else { return (500, r#"{"error":"state unavailable"}"#.into()) };
    match (request.method.as_str(), path) {
        ("GET", "/status") => (200, status_body(&runtime)),
        ("GET", "/upgrade/status") => match runtime.app.clone() {
            Some(app) => (200, serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "status": crate::upgrade::read_status(&app) }).to_string()),
            None => (200, r#"{"ok":false,"error":"not ready"}"#.into()),
        },
        (_, p) if p.starts_with("/mimir/") => {
            drop(runtime);
            let token = crate::mimir_host::api_token();
            if request.method != "POST" || token.is_empty() || bearer(&request.headers) != Some(token.as_str()) {
                return (401, r#"{"ok":false,"error":"Mimir token required"}"#.into());
            }
            super::mimir_api::route(manager, path, &request.body)
        }
        (_, p) if p.starts_with("/ai/") => {
            let authorized = !runtime.ai_token.is_empty() && bearer(&request.headers) == Some(runtime.ai_token.as_str());
            drop(runtime);
            if !authorized {
                return (401, r#"{"ok":false,"error":"Local AI token required"}"#.into());
            }
            ai_route(manager, request, path)
        }
        _ => (404, r#"{"error":"Not found"}"#.into()),
    }
}

fn ai_route(manager: &BridgeLinkManager, request: &HttpRequest, path: &str) -> (u16, String) {
    let since = || query_value(&request.target, "since").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    match (request.method.as_str(), path) {
        // Long-poll: returns as soon as a message newer than `since` exists, or after `timeout` seconds
        // (max 55) with an empty list. Lets agents react instantly without busy polling.
        ("GET", "/ai/wait") => {
            let since = since();
            let direction = query_value(&request.target, "direction").filter(|v| v == "in" || v == "out");
            let agent = query_value(&request.target, "for").filter(|v| !v.is_empty());
            let room = query_value(&request.target, "room").filter(|v| !v.is_empty());
            let filter = AiFilter { channel: None, agent: agent.as_deref(), room: room.as_deref() };
            let timeout = query_value(&request.target, "timeout").and_then(|v| v.parse::<u64>().ok()).unwrap_or(25).min(55);
            let deadline = Instant::now() + Duration::from_secs(timeout);
            let messages = loop {
                let found: Vec<AiMessage> = manager
                    .lock()
                    .map(|runtime| ai_messages_since(&runtime, since, &filter))
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|m| direction.as_deref().is_none_or(|d| m.direction == d))
                    .collect();
                if !found.is_empty() || Instant::now() >= deadline {
                    break found;
                }
                thread::sleep(Duration::from_millis(250));
            };
            (200, serde_json::json!({ "ok": true, "now": now_ms(), "messages": messages }).to_string())
        }
        ("GET", "/ai/messages") => {
            let channel = query_value(&request.target, "channel").filter(|v| !v.is_empty());
            let agent = query_value(&request.target, "for").filter(|v| !v.is_empty());
            let room = query_value(&request.target, "room").filter(|v| !v.is_empty());
            let filter = AiFilter { channel: channel.as_deref(), agent: agent.as_deref(), room: room.as_deref() };
            let messages = manager.lock().map(|runtime| ai_messages_since(&runtime, since(), &filter)).unwrap_or_default();
            (200, serde_json::json!({ "ok": true, "now": now_ms(), "messages": messages }).to_string())
        }
        ("POST", "/ai/send") => {
            let Ok(send) = serde_json::from_str::<AiSendWire>(&request.body) else {
                return (400, r#"{"ok":false,"error":"Expected JSON {author, body, channel?, replyTo?, to?, room?}"}"#.into());
            };
            match ai_send_internal(manager, send) {
                Ok(message) => (200, serde_json::json!({ "ok": true, "message": message }).to_string()),
                Err(error) => (409, serde_json::json!({ "ok": false, "error": error }).to_string()),
            }
        }
        ("GET", "/ai/workspace") => match manager.lock() {
            Ok(runtime) => (200, serde_json::json!({ "ok": true, "now": now_ms(), "workspace": runtime.workspace.state(now_ms()) }).to_string()),
            Err(error) => (500, serde_json::json!({ "ok": false, "error": error }).to_string()),
        },
        ("POST", _) => match serde_json::from_str::<serde_json::Value>(&request.body) {
            Ok(body) => match workspace_route(manager, path, &body) {
                Ok(value) => (200, serde_json::json!({ "ok": true, "result": value }).to_string()),
                Err(error) if error == "Not found" => (404, r#"{"error":"Not found"}"#.into()),
                Err(error) => (409, serde_json::json!({ "ok": false, "error": error }).to_string()),
            },
            Err(_) => (400, r#"{"ok":false,"error":"Expected a JSON body"}"#.into()),
        },
        _ => (404, r#"{"error":"Not found"}"#.into()),
    }
}

/// Workspace changes from this computer's agents. Every change is saved and pushed to paired devices.
fn workspace_route(manager: &BridgeLinkManager, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let text = |key: &str| body.get(key).and_then(|v| v.as_str());
    let list = |key: &str| body.get(key).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>());
    let need = |key: &str| text(key).filter(|v| !v.trim().is_empty()).ok_or(format!("`{key}` is required"));
    let now = now_ms();
    let value = {
        let mut runtime = manager.lock()?;
        let (device_id, device_name) = (runtime.instance_id.clone(), runtime.display_name.clone());
        let ws = &mut runtime.workspace;
        match path {
            "/ai/agents/hello" => {
                let agent = ws.hello(need("agent")?, text("status").unwrap_or(""), &device_id, &device_name, now);
                // Saying hello doesn't change shared data worth pushing at once; the minute push carries it.
                return serde_json::to_value(agent).map_err(|e| e.to_string());
            }
            "/ai/rooms" => serde_json::to_value(ws.create_room(need("title")?, need("agent")?, list("participants").unwrap_or_default(), now)?),
            "/ai/rooms/update" => serde_json::to_value(ws.update_room(need("room")?, text("title"), text("status"), list("participants"), now)?),
            "/ai/tasks" => serde_json::to_value(ws.add_task(need("room")?, need("title")?, text("assignee"), now)?),
            "/ai/tasks/update" => {
                let assignee = body.get("assignee").map(|v| v.as_str());
                serde_json::to_value(ws.update_task(need("room")?, need("task")?, text("status"), assignee, text("title"), now)?)
            }
            "/ai/claims" => serde_json::to_value(ws.claim(need("path")?, need("agent")?, text("room"), &device_id, &device_name, now)?),
            "/ai/claims/release" => {
                ws.release(need("path")?, Some(need("agent")?), now)?;
                Ok(serde_json::json!({ "released": true }))
            }
            _ => return Err("Not found".into()),
        }
        .map_err(|e| e.to_string())?
    };
    workspace::changed(manager);
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bridgedeck_origins_are_allowed() {
        assert!(origin_allowed(None), "CLI clients send no Origin");
        assert!(origin_allowed(Some("tauri://localhost")));
        assert!(origin_allowed(Some("http://tauri.localhost")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("null")));
    }

    #[test]
    fn mimir_routes_need_mimirs_token() {
        let manager = BridgeLinkManager::default();
        let request = |auth: Option<&str>| HttpRequest {
            method: "POST".into(),
            target: "/mimir/notes/search".into(),
            headers: auth.map(|a| HashMap::from([("authorization".to_string(), a.to_string())])).unwrap_or_default(),
            body: "{}".into(),
        };
        // Before Mimir has started there is no token, so nothing gets in.
        assert_eq!(route(&manager, &request(None), "/mimir/notes/search").0, 401);
        assert_eq!(route(&manager, &request(Some("Bearer ")), "/mimir/notes/search").0, 401);
        assert_eq!(route(&manager, &request(Some("Bearer guess")), "/mimir/notes/search").0, 401);
    }

    #[test]
    fn query_values_are_parsed() {
        assert_eq!(query_value("/ai/wait?since=5&timeout=9", "timeout").as_deref(), Some("9"));
        assert_eq!(query_value("/ai/wait", "since"), None);
    }
}
