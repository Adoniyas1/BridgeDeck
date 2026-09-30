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

const MAX_HTTP_BYTES: usize = 64 * 1024;

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
        (_, "/ai/wait" | "/ai/messages" | "/ai/send") => {
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
            let timeout = query_value(&request.target, "timeout").and_then(|v| v.parse::<u64>().ok()).unwrap_or(25).min(55);
            let deadline = Instant::now() + Duration::from_secs(timeout);
            let messages = loop {
                let found: Vec<AiMessage> = manager
                    .lock()
                    .map(|runtime| ai_messages_since(&runtime, since, None))
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
            let messages = manager.lock().map(|runtime| ai_messages_since(&runtime, since(), channel.as_deref())).unwrap_or_default();
            (200, serde_json::json!({ "ok": true, "now": now_ms(), "messages": messages }).to_string())
        }
        ("POST", "/ai/send") => {
            let Ok(send) = serde_json::from_str::<AiSendWire>(&request.body) else {
                return (400, r#"{"ok":false,"error":"Expected JSON {author, body, channel?, replyTo?}"}"#.into());
            };
            match ai_send_internal(manager, send) {
                Ok(message) => (200, serde_json::json!({ "ok": true, "message": message }).to_string()),
                Err(error) => (409, serde_json::json!({ "ok": false, "error": error }).to_string()),
            }
        }
        _ => (404, r#"{"error":"Not found"}"#.into()),
    }
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
    fn query_values_are_parsed() {
        assert_eq!(query_value("/ai/wait?since=5&timeout=9", "timeout").as_deref(), Some("9"));
        assert_eq!(query_value("/ai/wait", "since"), None);
    }
}
