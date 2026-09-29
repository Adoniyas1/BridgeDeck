use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const DISCOVERY_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 77);
const DISCOVERY_PORT: u16 = 41415;
const DEFAULT_API_PORT: u16 = 41416;
const PEER_STALE_MS: u64 = 12_000;
const MAX_HTTP_BYTES: usize = 64 * 1024;
const MAX_PENDING: usize = 20;
const MAX_AI_MESSAGES: usize = 500;
const MAX_AI_BODY: usize = 24 * 1024; // leaves room for JSON escaping under MAX_HTTP_BYTES
const DEFAULT_AI_CHANNEL: &str = "shared-agents";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkPeer {
    pub instance_id: String,
    pub name: String,
    pub platform: String,
    pub host: String,
    pub api_port: u16,
    pub last_seen: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkPending {
    pub request_id: String,
    pub peer_instance_id: String,
    pub peer_name: String,
    pub peer_platform: String,
    pub host: String,
    pub api_port: u16,
    pub pairing_code: String,
    pub rustdesk_peer_id: Option<String>,
    pub localsend_target: String,
    pub syncthing_device_id: Option<String>,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkOutgoing {
    pub request_id: String,
    pub peer_instance_id: String,
    pub peer_name: String,
    pub peer_platform: String,
    pub host: String,
    pub api_port: u16,
    pub pairing_code: String,
    pub state: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkPairedPeer {
    pub instance_id: String,
    pub name: String,
    pub platform: String,
    pub host: String,
    pub api_port: u16,
    pub access_token: String,
    pub rustdesk_peer_id: Option<String>,
    pub localsend_target: String,
    pub syncthing_device_id: Option<String>,
    /// BlueBubbles Server on the peer (Mac), e.g. `http://192.168.4.28:1234`. Never includes the password.
    pub bluebubbles_url: Option<String>,
    pub paired_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkStatus {
    pub running: bool,
    pub instance_id: String,
    pub display_name: String,
    pub platform: String,
    pub api_port: u16,
    pub discovered: Vec<BridgeLinkPeer>,
    pub pending: Vec<BridgeLinkPending>,
    pub outgoing: Option<BridgeLinkOutgoing>,
    pub paired: Vec<BridgeLinkPairedPeer>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkPairResult {
    pub paired: bool,
    pub peer: Option<BridgeLinkPairedPeer>,
    pub detail: String,
}

/// One message in the AI relay between paired computers. Bodies are plain data:
/// BridgeLink never executes anything based on message content.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub id: String,
    pub channel: String,
    pub author: String,
    pub body: String,
    pub reply_to: Option<String>,
    /// "in" = received from a paired peer, "out" = sent from this computer.
    pub direction: String,
    pub peer_instance_id: String,
    pub peer_name: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiInboxWire {
    id: String,
    channel: String,
    author: String,
    body: String,
    reply_to: Option<String>,
    created_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSendWire {
    author: String,
    body: String,
    channel: Option<String>,
    reply_to: Option<String>,
    peer_instance_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityFile {
    instance_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedPeer {
    instance_id: String,
    name: String,
    platform: String,
    host: String,
    api_port: u16,
    access_token: String,
    issued_token: String,
    rustdesk_peer_id: Option<String>,
    localsend_port: u16,
    syncthing_device_id: Option<String>,
    #[serde(default)]
    bluebubbles_port: Option<u16>,
    paired_at: u64,
}

impl PersistedPeer {
    fn public(&self) -> BridgeLinkPairedPeer {
        BridgeLinkPairedPeer {
            instance_id: self.instance_id.clone(),
            name: self.name.clone(),
            platform: self.platform.clone(),
            host: self.host.clone(),
            api_port: self.api_port,
            access_token: self.access_token.clone(),
            rustdesk_peer_id: self.rustdesk_peer_id.clone(),
            localsend_target: format_host_port(&self.host, self.localsend_port),
            syncthing_device_id: self.syncthing_device_id.clone(),
            bluebubbles_url: self.bluebubbles_port.map(|port| format!("http://{}", format_host_port(&self.host, port))),
            paired_at: self.paired_at,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryWire {
    protocol: String,
    instance_id: String,
    name: String,
    platform: String,
    api_port: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequestWire {
    request_id: String,
    instance_id: String,
    name: String,
    platform: String,
    api_port: u16,
    pairing_code: String,
    issued_token: String,
    rustdesk_id: Option<String>,
    localsend_port: u16,
    syncthing_device_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairStatusWire {
    status: String,
    name: Option<String>,
    platform: Option<String>,
    api_port: Option<u16>,
    issued_token: Option<String>,
    rustdesk_id: Option<String>,
    localsend_port: Option<u16>,
    syncthing_device_id: Option<String>,
    detail: Option<String>,
}

#[derive(Clone, Debug)]
struct IncomingPair {
    request: PairRequestWire,
    host: String,
    created_at: u64,
}

#[derive(Clone, Debug)]
struct OutgoingInternal {
    summary: BridgeLinkOutgoing,
    issued_token: String,
}

struct BridgeLinkRuntime {
    running: bool,
    instance_id: String,
    display_name: String,
    platform: String,
    api_port: u16,
    rustdesk_id: Option<String>,
    localsend_port: u16,
    syncthing_device_id: Option<String>,
    discovered: HashMap<String, BridgeLinkPeer>,
    pending: HashMap<String, IncomingPair>,
    outcomes: HashMap<String, PairStatusWire>,
    outgoing: Option<OutgoingInternal>,
    paired: HashMap<String, PersistedPeer>,
    ai_messages: Vec<AiMessage>,
    ai_token: String,
    /// For desktop notifications and UI events when relay messages arrive.
    app: Option<AppHandle>,
    /// Remote contact-edit rate limiting (see reserve_contact_edit).
    contact_edits: Vec<Instant>,
    contact_edit_busy: bool,
    shutdown: Arc<AtomicBool>,
    storage_dir: Option<PathBuf>,
    detail: Option<String>,
}

impl Default for BridgeLinkRuntime {
    fn default() -> Self {
        Self {
            running: false,
            instance_id: String::new(),
            display_name: "BridgeDeck".to_string(),
            platform: platform_key().to_string(),
            api_port: DEFAULT_API_PORT,
            rustdesk_id: None,
            localsend_port: 53317,
            syncthing_device_id: None,
            discovered: HashMap::new(),
            pending: HashMap::new(),
            outcomes: HashMap::new(),
            outgoing: None,
            paired: HashMap::new(),
            ai_messages: Vec::new(),
            ai_token: String::new(),
            app: None,
            contact_edits: Vec::new(),
            contact_edit_busy: false,
            shutdown: Arc::new(AtomicBool::new(false)),
            storage_dir: None,
            detail: Some("Automatic pairing is stopped".to_string()),
        }
    }
}

#[derive(Clone, Default)]
pub struct BridgeLinkManager {
    inner: Arc<Mutex<BridgeLinkRuntime>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn platform_key() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        return "windows";
    }
    #[cfg(target_os = "macos")]
    {
        return "macos";
    }
    #[cfg(target_os = "linux")]
    {
        return "linux";
    }
    #[allow(unreachable_code)]
    "unknown"
}

fn local_name() -> String {
    if let Ok(value) = std::env::var("COMPUTERNAME") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    if let Ok(value) = std::env::var("HOSTNAME") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(output) = Command::new("scutil").args(["--get", "ComputerName"]).output() {
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return value;
            }
        }
    }
    if let Ok(output) = Command::new("hostname").output() {
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return value;
            }
        }
    }
    "BridgeDeck".to_string()
}

fn storage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("bridgelink");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn secure_write(path: &Path, raw: &str) -> Result<(), String> {
    fs::write(path, raw).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn load_or_create_identity(dir: &Path) -> Result<String, String> {
    let path = dir.join("identity.json");
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let parsed: IdentityFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if !parsed.instance_id.trim().is_empty() {
            return Ok(parsed.instance_id);
        }
    }
    let identity = IdentityFile {
        instance_id: Uuid::new_v4().to_string(),
    };
    secure_write(
        &path,
        &serde_json::to_string_pretty(&identity).map_err(|e| e.to_string())?,
    )?;
    Ok(identity.instance_id)
}

fn load_peers(dir: &Path) -> HashMap<String, PersistedPeer> {
    let path = dir.join("peers.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(list) = serde_json::from_str::<Vec<PersistedPeer>>(&raw) else {
        return HashMap::new();
    };
    list.into_iter().map(|p| (p.instance_id.clone(), p)).collect()
}

fn save_peers(runtime: &BridgeLinkRuntime) -> Result<(), String> {
    let Some(dir) = runtime.storage_dir.as_ref() else {
        return Err("BridgeLink storage is not initialized".into());
    };
    let mut list: Vec<PersistedPeer> = runtime.paired.values().cloned().collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let raw = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    secure_write(&dir.join("peers.json"), &raw)
}

/// Token that local AI clients (CLI scripts) must present to /ai/send and /ai/messages.
/// Stored in a user-only file so a web page cannot use the loopback API to inject messages.
fn load_or_create_ai_token(dir: &Path) -> Result<String, String> {
    let path = dir.join("ai-token");
    if let Ok(raw) = fs::read_to_string(&path) {
        let token = raw.trim().to_string();
        if token.len() >= 32 {
            return Ok(token);
        }
    }
    let token = random_token();
    secure_write(&path, &token)?;
    Ok(token)
}

fn load_ai_messages(dir: &Path) -> Vec<AiMessage> {
    let Ok(raw) = fs::read_to_string(dir.join("ai-messages.jsonl")) else {
        return Vec::new();
    };
    let mut list: Vec<AiMessage> = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<AiMessage>(line).ok())
        .collect();
    if list.len() > MAX_AI_MESSAGES {
        list.drain(..list.len() - MAX_AI_MESSAGES);
        let compacted: Vec<String> = list.iter().filter_map(|m| serde_json::to_string(m).ok()).collect();
        let _ = secure_write(&dir.join("ai-messages.jsonl"), &(compacted.join("\n") + "\n"));
    }
    list
}

fn record_ai_message(runtime: &mut BridgeLinkRuntime, message: AiMessage) {
    if let Some(dir) = runtime.storage_dir.as_ref() {
        if let Ok(line) = serde_json::to_string(&message) {
            let path = dir.join("ai-messages.jsonl");
            let existed = path.exists();
            if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
                let _ = writeln!(file, "{line}");
            }
            #[cfg(unix)]
            if !existed {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
            }
            let _ = existed;
        }
    }
    runtime.ai_messages.push(message);
    if runtime.ai_messages.len() > MAX_AI_MESSAGES {
        let excess = runtime.ai_messages.len() - MAX_AI_MESSAGES;
        runtime.ai_messages.drain(..excess);
    }
}

/// Desktop notification plus a UI event for an incoming relay message. The preview is plain text
/// (the notification renderer does not interpret markup) and is cut to keep toasts readable.
fn notify_ai_message(app: &AppHandle, message: &AiMessage) {
    use tauri::Emitter;
    use tauri_plugin_notification::NotificationExt;
    let _ = app.emit("ai-message", message);
    let preview: String = message.body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(180).collect();
    let _ = app
        .notification()
        .builder()
        .title(format!("{} · {}", message.author, message.peer_name))
        .body(preview)
        .show();
}

/// Keeps author/channel labels short and printable; they are shown in UIs and prompts.
fn clean_label(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(32)
        .collect();
    if cleaned.is_empty() { fallback.to_string() } else { cleaned }
}

fn clean_id(value: &str) -> Option<String> {
    let cleaned: String = value.trim().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn validate_ai_body(body: &str) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("Message body is empty".into());
    }
    if body.len() > MAX_AI_BODY {
        return Err(format!("Message body exceeds {MAX_AI_BODY} bytes"));
    }
    Ok(())
}

fn snapshot(runtime: &mut BridgeLinkRuntime) -> BridgeLinkStatus {
    let now = now_ms();
    runtime
        .discovered
        .retain(|_, peer| now.saturating_sub(peer.last_seen) <= PEER_STALE_MS);
    runtime
        .pending
        .retain(|_, pending| now.saturating_sub(pending.created_at) <= 5 * 60_000);

    let mut discovered: Vec<_> = runtime.discovered.values().cloned().collect();
    discovered.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let mut pending: Vec<_> = runtime
        .pending
        .values()
        .map(|p| BridgeLinkPending {
            request_id: p.request.request_id.clone(),
            peer_instance_id: p.request.instance_id.clone(),
            peer_name: p.request.name.clone(),
            peer_platform: p.request.platform.clone(),
            host: p.host.clone(),
            api_port: p.request.api_port,
            pairing_code: p.request.pairing_code.clone(),
            rustdesk_peer_id: p.request.rustdesk_id.clone(),
            localsend_target: format_host_port(&p.host, p.request.localsend_port),
            syncthing_device_id: p.request.syncthing_device_id.clone(),
            created_at: p.created_at,
        })
        .collect();
    pending.sort_by_key(|p| p.created_at);
    let mut paired: Vec<_> = runtime.paired.values().map(PersistedPeer::public).collect();
    paired.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    BridgeLinkStatus {
        running: runtime.running,
        instance_id: runtime.instance_id.clone(),
        display_name: runtime.display_name.clone(),
        platform: runtime.platform.clone(),
        api_port: runtime.api_port,
        discovered,
        pending,
        outgoing: runtime.outgoing.as_ref().map(|o| o.summary.clone()),
        paired,
        detail: runtime.detail.clone(),
    }
}

fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn pairing_code() -> String {
    format!("{:06}", (Uuid::new_v4().as_u128() % 1_000_000) as u32)
}

fn write_http(stream: &mut TcpStream, status: u16, body: &str) -> Result<(), String> {
    let label = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {label}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream.write_all(response.as_bytes()).map_err(|e| e.to_string())
}

struct HttpRequest {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: String,
}

fn read_http(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
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
            return Err("BridgeLink request too large".into());
        }
        if header_end.is_none() {
            if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
                let head = String::from_utf8_lossy(&buffer[..pos + 4]);
                for line in head.lines().skip(1) {
                    if let Some((name, value)) = line.split_once(':') {
                        if name.trim().eq_ignore_ascii_case("content-length") {
                            content_len = value.trim().parse::<usize>().unwrap_or(0);
                        }
                    }
                }
            }
        }
        if let Some(end) = header_end {
            if buffer.len() >= end.saturating_add(content_len) {
                break;
            }
        }
    }
    let end = header_end.ok_or("Invalid HTTP request")?;
    let head = String::from_utf8(buffer[..end].to_vec()).map_err(|e| e.to_string())?;
    let body = String::from_utf8(buffer[end..].to_vec()).map_err(|e| e.to_string())?;
    let mut lines = head.lines();
    let request_line = lines.next().ok_or("Missing request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    Ok(HttpRequest {
        method,
        target,
        headers,
        body,
    })
}

fn query_value(target: &str, key: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    for part in query.split('&') {
        let (name, value) = part.split_once('=').unwrap_or((part, ""));
        if name == key {
            return Some(value.to_string());
        }
    }
    None
}

fn bearer(headers: &HashMap<String, String>) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
}

fn authorized(runtime: &BridgeLinkRuntime, addr: SocketAddr, token: Option<&str>) -> bool {
    if addr.ip().is_loopback() {
        return true;
    }
    let Some(token) = token else {
        return false;
    };
    runtime.paired.values().any(|peer| peer.issued_token == token)
        || runtime
            .outgoing
            .as_ref()
            .is_some_and(|outgoing| outgoing.issued_token == token)
}

fn ai_local_authorized(runtime: &BridgeLinkRuntime, addr: SocketAddr, token: Option<&str>) -> bool {
    addr.ip().is_loopback() && !runtime.ai_token.is_empty() && token == Some(runtime.ai_token.as_str())
}

fn lock_or_500<'a>(
    manager: &'a BridgeLinkManager,
    stream: &mut TcpStream,
) -> Option<std::sync::MutexGuard<'a, BridgeLinkRuntime>> {
    match manager.inner.lock() {
        Ok(runtime) => Some(runtime),
        Err(_) => {
            let _ = write_http(stream, 500, r#"{"error":"state unavailable"}"#);
            None
        }
    }
}

/// Records an outgoing message and delivers it to the paired peer's /ai/inbox.
fn ai_send_internal(manager: &BridgeLinkManager, send: AiSendWire) -> Result<AiMessage, String> {
    validate_ai_body(&send.body)?;
    let peer = {
        let runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
        if !runtime.running {
            return Err("BridgeLink is not running".into());
        }
        match send.peer_instance_id.as_deref().filter(|v| !v.trim().is_empty()) {
            Some(id) => runtime.paired.get(id).cloned().ok_or("Paired computer not found")?,
            None => {
                let mut peers: Vec<_> = runtime.paired.values().cloned().collect();
                if peers.len() > 1 {
                    return Err("More than one paired computer; specify peerInstanceId".into());
                }
                peers.pop().ok_or("No paired computer. Pair the Mac and Windows computers first.")?
            }
        }
    };
    let wire = AiInboxWire {
        id: Uuid::new_v4().to_string(),
        channel: clean_label(send.channel.as_deref().unwrap_or(""), DEFAULT_AI_CHANNEL),
        author: clean_label(&send.author, "agent"),
        body: send.body,
        reply_to: send.reply_to.filter(|v| !v.trim().is_empty()),
        created_at: now_ms(),
    };
    let payload = serde_json::to_string(&wire).map_err(|e| e.to_string())?;
    let (status, response) = http_json_bearer(&peer.host, peer.api_port, "POST", "/ai/inbox", &peer.access_token, Some(&payload))?;
    if !(200..300).contains(&status) {
        return Err(if status == 404 {
            format!("{} does not support the AI relay yet (update BridgeDeck there)", peer.name)
        } else {
            format!("{} rejected the message: HTTP {status} {response}", peer.name)
        });
    }
    let message = AiMessage {
        id: wire.id,
        channel: wire.channel,
        author: wire.author,
        body: wire.body,
        reply_to: wire.reply_to,
        direction: "out".into(),
        peer_instance_id: peer.instance_id.clone(),
        peer_name: peer.name.clone(),
        created_at: wire.created_at,
    };
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    record_ai_message(&mut runtime, message.clone());
    Ok(message)
}

fn ai_messages_since(runtime: &BridgeLinkRuntime, since: u64, channel: Option<&str>) -> Vec<AiMessage> {
    runtime
        .ai_messages
        .iter()
        .filter(|m| m.created_at > since && channel.is_none_or(|c| m.channel == c))
        .cloned()
        .collect()
}

fn status_body(runtime: &BridgeLinkRuntime) -> String {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "hostname": runtime.display_name,
        "platform": runtime.platform,
        "arch": std::env::consts::ARCH,
        "uptimeSeconds": sysinfo::System::uptime(),
        "totalMemory": system.total_memory(),
        "freeMemory": system.available_memory(),
        "timestamp": now_ms().to_string(),
        "bridgeInstanceId": runtime.instance_id,
        "rustdeskPeerId": runtime.rustdesk_id,
        "localsendPort": runtime.localsend_port,
        "syncthingDeviceId": runtime.syncthing_device_id,
        "bluebubblesPort": local_bluebubbles_port(),
    })
    .to_string()
}

/// BlueBubbles Server's default port, advertised only when the server is actually listening here.
const BLUEBUBBLES_PORT: u16 = 1234;

pub fn local_bluebubbles_port() -> Option<u16> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), BLUEBUBBLES_PORT);
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).ok().map(|_| BLUEBUBBLES_PORT)
}

fn handle_api_connection(mut stream: TcpStream, addr: SocketAddr, manager: BridgeLinkManager) {
    // The listener is non-blocking and macOS (BSD) sockets inherit that on accept, which makes
    // read_http fail with EAGAIN whenever a request spans more than one packet.
    let _ = stream.set_nonblocking(false);
    let request = match read_http(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_http(&mut stream, 400, &serde_json::json!({ "error": error }).to_string());
            return;
        }
    };
    if request.method == "OPTIONS" {
        let _ = write_http(&mut stream, 204, "");
        return;
    }
    let path = request.target.split('?').next().unwrap_or(&request.target);

    if request.method == "GET" && path == "/status" {
        let runtime = match manager.inner.lock() {
            Ok(runtime) => runtime,
            Err(_) => {
                let _ = write_http(&mut stream, 500, r#"{"error":"state unavailable"}"#);
                return;
            }
        };
        if !authorized(&runtime, addr, bearer(&request.headers)) {
            let _ = write_http(&mut stream, 401, r#"{"ok":false,"error":"Bearer token required"}"#);
            return;
        }
        let _ = write_http(&mut stream, 200, &status_body(&runtime));
        return;
    }

    if request.method == "POST" && path == "/pair/request" {
        let parsed = serde_json::from_str::<PairRequestWire>(&request.body);
        let Ok(pair) = parsed else {
            let _ = write_http(&mut stream, 400, r#"{"error":"Invalid pair request"}"#);
            return;
        };
        let mut runtime = match manager.inner.lock() {
            Ok(runtime) => runtime,
            Err(_) => {
                let _ = write_http(&mut stream, 500, r#"{"error":"state unavailable"}"#);
                return;
            }
        };
        if pair.instance_id == runtime.instance_id {
            let _ = write_http(&mut stream, 400, r#"{"error":"Cannot pair with this instance"}"#);
            return;
        }
        if runtime.pending.len() >= MAX_PENDING && !runtime.pending.contains_key(&pair.request_id) {
            let _ = write_http(&mut stream, 409, r#"{"error":"Too many pending requests"}"#);
            return;
        }
        runtime.pending.insert(
            pair.request_id.clone(),
            IncomingPair {
                request: pair,
                host: addr.ip().to_string(),
                created_at: now_ms(),
            },
        );
        runtime.detail = Some("Incoming BridgeDeck pairing request".into());
        let _ = write_http(&mut stream, 202, r#"{"status":"pending"}"#);
        return;
    }

    if request.method == "GET" && path == "/pair/status" {
        let Some(request_id) = query_value(&request.target, "requestId") else {
            let _ = write_http(&mut stream, 400, r#"{"error":"requestId is required"}"#);
            return;
        };
        let runtime = match manager.inner.lock() {
            Ok(runtime) => runtime,
            Err(_) => {
                let _ = write_http(&mut stream, 500, r#"{"error":"state unavailable"}"#);
                return;
            }
        };
        let response = runtime.outcomes.get(&request_id).cloned().unwrap_or(PairStatusWire {
            status: if runtime.pending.contains_key(&request_id) { "pending".into() } else { "unknown".into() },
            name: None,
            platform: None,
            api_port: None,
            issued_token: None,
            rustdesk_id: None,
            localsend_port: None,
            syncthing_device_id: None,
            detail: None,
        });
        let _ = write_http(&mut stream, 200, &serde_json::to_string(&response).unwrap_or_else(|_| r#"{"status":"error"}"#.into()));
        return;
    }

    // Peer -> this computer. Only a paired peer's token is accepted (no loopback bypass),
    // and the sender identity comes from our peer record, not from the payload.
    if request.method == "POST" && path == "/ai/inbox" {
        let Some(mut runtime) = lock_or_500(&manager, &mut stream) else { return };
        let token = bearer(&request.headers).unwrap_or("");
        let Some(peer) = runtime.paired.values().find(|p| !token.is_empty() && p.issued_token == token).cloned() else {
            let _ = write_http(&mut stream, 401, r#"{"ok":false,"error":"Paired-peer bearer token required"}"#);
            return;
        };
        let Ok(wire) = serde_json::from_str::<AiInboxWire>(&request.body) else {
            let _ = write_http(&mut stream, 400, r#"{"ok":false,"error":"Invalid AI message"}"#);
            return;
        };
        if let Err(error) = validate_ai_body(&wire.body) {
            let _ = write_http(&mut stream, 400, &serde_json::json!({ "ok": false, "error": error }).to_string());
            return;
        }
        if !clean_id(&wire.id).is_some_and(|id| runtime.ai_messages.iter().any(|m| m.id == id)) {
            let message = AiMessage {
                id: clean_id(&wire.id).unwrap_or_else(|| Uuid::new_v4().to_string()),
                channel: clean_label(&wire.channel, DEFAULT_AI_CHANNEL),
                author: clean_label(&wire.author, "agent"),
                body: wire.body,
                reply_to: wire.reply_to.as_deref().and_then(clean_id),
                direction: "in".into(),
                peer_instance_id: peer.instance_id.clone(),
                peer_name: peer.name.clone(),
                created_at: now_ms(),
            };
            let notify = runtime.app.clone().map(|app| (app, message.clone()));
            record_ai_message(&mut runtime, message);
            drop(runtime);
            if let Some((app, message)) = notify {
                notify_ai_message(&app, &message);
            }
        }
        let _ = write_http(&mut stream, 202, r#"{"ok":true}"#);
        return;
    }

    // Local AI client -> long-poll: returns as soon as a message newer than `since` exists, or after
    // `timeout` seconds (max 55) with an empty list. Lets agents react instantly without busy polling.
    if request.method == "GET" && path == "/ai/wait" {
        {
            let Some(runtime) = lock_or_500(&manager, &mut stream) else { return };
            if !ai_local_authorized(&runtime, addr, bearer(&request.headers)) {
                let _ = write_http(&mut stream, 401, r#"{"ok":false,"error":"Local AI token required"}"#);
                return;
            }
        }
        let since = query_value(&request.target, "since").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        let direction = query_value(&request.target, "direction").filter(|v| v == "in" || v == "out");
        let timeout = query_value(&request.target, "timeout").and_then(|v| v.parse::<u64>().ok()).unwrap_or(25).min(55);
        let deadline = Instant::now() + Duration::from_secs(timeout);
        let messages = loop {
            let found: Vec<AiMessage> = match manager.inner.lock() {
                Ok(runtime) => ai_messages_since(&runtime, since, None)
                    .into_iter()
                    .filter(|m| direction.as_deref().is_none_or(|d| m.direction == d))
                    .collect(),
                Err(_) => Vec::new(),
            };
            if !found.is_empty() || Instant::now() >= deadline {
                break found;
            }
            thread::sleep(Duration::from_millis(250));
        };
        let body = serde_json::json!({ "ok": true, "now": now_ms(), "messages": messages }).to_string();
        let _ = write_http(&mut stream, 200, &body);
        return;
    }

    // Local AI client -> read the relay log.
    if request.method == "GET" && path == "/ai/messages" {
        let Some(runtime) = lock_or_500(&manager, &mut stream) else { return };
        if !ai_local_authorized(&runtime, addr, bearer(&request.headers)) {
            let _ = write_http(&mut stream, 401, r#"{"ok":false,"error":"Local AI token required"}"#);
            return;
        }
        let since = query_value(&request.target, "since").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        let channel = query_value(&request.target, "channel").filter(|v| !v.is_empty());
        let messages = ai_messages_since(&runtime, since, channel.as_deref());
        let body = serde_json::json!({ "ok": true, "now": now_ms(), "messages": messages }).to_string();
        let _ = write_http(&mut stream, 200, &body);
        return;
    }

    // Local AI client -> send to the paired peer.
    if request.method == "POST" && path == "/ai/send" {
        {
            let Some(runtime) = lock_or_500(&manager, &mut stream) else { return };
            if !ai_local_authorized(&runtime, addr, bearer(&request.headers)) {
                let _ = write_http(&mut stream, 401, r#"{"ok":false,"error":"Local AI token required"}"#);
                return;
            }
        }
        let Ok(send) = serde_json::from_str::<AiSendWire>(&request.body) else {
            let _ = write_http(&mut stream, 400, r#"{"ok":false,"error":"Expected JSON {author, body, channel?, replyTo?}"}"#);
            return;
        };
        let _ = match ai_send_internal(&manager, send) {
            Ok(message) => write_http(&mut stream, 200, &serde_json::json!({ "ok": true, "message": message }).to_string()),
            Err(error) => write_http(&mut stream, 409, &serde_json::json!({ "ok": false, "error": error }).to_string()),
        };
        return;
    }

    // Paired peer -> this Mac: save a contact edit in the Contacts app. Requires the paired-peer token,
    // is rate limited, and the user on this Mac must approve each edit in a dialog (the token crosses
    // the LAN in plaintext, so a captured token alone must not be able to change Contacts).
    if request.method == "POST" && path == "/contacts/save" {
        if !cfg!(target_os = "macos") {
            let _ = write_http(&mut stream, 404, r#"{"ok":false,"error":"Contacts are only editable on the Mac"}"#);
            return;
        }
        let (peer_name, app) = match manager.inner.lock() {
            Ok(runtime) => {
                let token = bearer(&request.headers).unwrap_or("");
                (runtime.paired.values().find(|p| !token.is_empty() && p.issued_token == token).map(|p| p.name.clone()), runtime.app.clone())
            }
            Err(_) => (None, None),
        };
        let Some(peer_name) = peer_name else {
            let _ = write_http(&mut stream, 401, r#"{"ok":false,"error":"Paired-peer bearer token required"}"#);
            return;
        };
        let Ok(req) = serde_json::from_str::<ContactSaveRequest>(&request.body) else {
            let _ = write_http(&mut stream, 400, r#"{"ok":false,"error":"Invalid contact request"}"#);
            return;
        };
        if let Err(error) = req.validate().and_then(|_| reserve_contact_edit(&manager)) {
            let _ = write_http(&mut stream, 409, &serde_json::json!({ "ok": false, "error": error }).to_string());
            return;
        }
        let approved = app.as_ref().is_some_and(|app| confirm_remote_contact_edit(app, &peer_name, &req));
        let result = if approved { crate::save_apple_contact(&req) } else { Err("The change was not approved on the Mac".to_string()) };
        release_contact_edit(&manager);
        let _ = match result {
            Ok(id) => write_http(&mut stream, 200, &serde_json::json!({ "ok": true, "id": id }).to_string()),
            Err(error) => write_http(&mut stream, 409, &serde_json::json!({ "ok": false, "error": error }).to_string()),
        };
        return;
    }
    let _ = write_http(&mut stream, 404, r#"{"error":"Not found"}"#);
}

fn spawn_api(listener: TcpListener, manager: BridgeLinkManager, shutdown: Arc<AtomicBool>) {
    thread::spawn(move || {
        let _ = listener.set_nonblocking(true);
        while !shutdown.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, addr)) => {
                    let manager = manager.clone();
                    thread::spawn(move || handle_api_connection(stream, addr, manager));
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(80));
                }
                Err(_) => thread::sleep(Duration::from_millis(150)),
            }
        }
    });
}

fn spawn_discovery(socket: UdpSocket, manager: BridgeLinkManager, shutdown: Arc<AtomicBool>) {
    thread::spawn(move || {
        let _ = socket.set_read_timeout(Some(Duration::from_millis(450)));
        let _ = socket.set_multicast_ttl_v4(1);
        let _ = socket.set_multicast_loop_v4(true);
        let mut last_announce = Instant::now() - Duration::from_secs(10);
        let target = SocketAddr::new(IpAddr::V4(DISCOVERY_ADDR), DISCOVERY_PORT);
        let mut buffer = [0u8; 8192];
        while !shutdown.load(Ordering::Relaxed) {
            if last_announce.elapsed() >= Duration::from_secs(2) {
                let wire = {
                    let Ok(runtime) = manager.inner.lock() else {
                        break;
                    };
                    DiscoveryWire {
                        protocol: "bridgedeck-link/1".into(),
                        instance_id: runtime.instance_id.clone(),
                        name: runtime.display_name.clone(),
                        platform: runtime.platform.clone(),
                        api_port: runtime.api_port,
                    }
                };
                if let Ok(raw) = serde_json::to_vec(&wire) {
                    let _ = socket.send_to(&raw, target);
                }
                last_announce = Instant::now();
            }

            match socket.recv_from(&mut buffer) {
                Ok((count, addr)) => {
                    let Ok(wire) = serde_json::from_slice::<DiscoveryWire>(&buffer[..count]) else {
                        continue;
                    };
                    if wire.protocol != "bridgedeck-link/1" {
                        continue;
                    }
                    let Ok(mut runtime) = manager.inner.lock() else {
                        break;
                    };
                    if wire.instance_id == runtime.instance_id {
                        continue;
                    }
                    // Keep a paired peer reachable when DHCP hands it a new address.
                    let host = addr.ip().to_string();
                    let moved = runtime.paired.get_mut(&wire.instance_id).is_some_and(|peer| {
                        let changed = peer.host != host || peer.api_port != wire.api_port;
                        if changed {
                            peer.host = host.clone();
                            peer.api_port = wire.api_port;
                        }
                        changed
                    });
                    if moved {
                        let _ = save_peers(&runtime);
                    }
                    runtime.discovered.insert(
                        wire.instance_id.clone(),
                        BridgeLinkPeer {
                            instance_id: wire.instance_id,
                            name: wire.name,
                            platform: wire.platform,
                            host: addr.ip().to_string(),
                            api_port: wire.api_port,
                            last_seen: now_ms(),
                        },
                    );
                }
                Err(err)
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => thread::sleep(Duration::from_millis(150)),
            }
        }
    });
}

fn http_json(
    host: &str,
    port: u16,
    method: &str,
    target: &str,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect((host, port)).map_err(|e| format!("Could not reach BridgeDeck at {host}:{port}: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(4)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(4)))
        .map_err(|e| e.to_string())?;
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {target} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        format_host_port(host, port),
        body.as_bytes().len(),
        body
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8(raw).map_err(|e| e.to_string())?;
    let (head, body) = text.split_once("\r\n\r\n").ok_or("Invalid BridgeLink response")?;
    let code = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or("Invalid BridgeLink response status")?;
    Ok((code, body.to_string()))
}

#[tauri::command]
pub fn bridgelink_start(
    app: AppHandle,
    display_name: String,
    api_port: u16,
    rustdesk_id: String,
    localsend_port: u16,
    syncthing_id: String,
    manager: State<'_, BridgeLinkManager>,
) -> Result<BridgeLinkStatus, String> {
    start(&app, &manager, display_name, api_port, rustdesk_id, localsend_port, syncthing_id)
}

/// Starts discovery and the API, or updates the advertised metadata when already running.
/// Called at process start (see `lib.rs` setup) and again by the UI once it has loaded.
pub fn start(
    app: &AppHandle,
    manager: &BridgeLinkManager,
    display_name: String,
    api_port: u16,
    rustdesk_id: String,
    localsend_port: u16,
    syncthing_id: String,
) -> Result<BridgeLinkStatus, String> {
    let port = if api_port == 0 { DEFAULT_API_PORT } else { api_port };
    let restarting = {
        let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
        if runtime.running && runtime.api_port == port {
            // Already listening: only refresh what is advertised. Never stop/start here; the UI calls
            // this after load, and a stop followed by a delayed start (throttled timers in a hidden
            // window) left the API down for minutes.
            runtime.display_name = if display_name.trim().is_empty() { local_name() } else { display_name.trim().to_string() };
            if !rustdesk_id.trim().is_empty() { runtime.rustdesk_id = Some(rustdesk_id.trim().to_string()); }
            runtime.localsend_port = if localsend_port == 0 { 53317 } else { localsend_port };
            if !syncthing_id.trim().is_empty() { runtime.syncthing_device_id = Some(syncthing_id.trim().to_string()); }
            return Ok(snapshot(&mut runtime));
        }
        if runtime.running {
            // API port changed in settings: shut the old listeners down and rebind below.
            runtime.shutdown.store(true, Ordering::Relaxed);
            runtime.running = false;
            true
        } else {
            false
        }
    };
    if restarting {
        // Listener threads notice shutdown within ~80 ms (TCP) and ~450 ms (UDP recv timeout).
        thread::sleep(Duration::from_millis(600));
    }

    let dir = storage_dir(&app)?;
    let instance_id = load_or_create_identity(&dir)?;
    let peers = load_peers(&dir);
    let ai_token = load_or_create_ai_token(&dir)?;
    let ai_messages = load_ai_messages(&dir);
    let listener = TcpListener::bind(("0.0.0.0", port)).map_err(|e| format!("Could not bind BridgeLink API port {port}: {e}"))?;
    let udp = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)).map_err(|e| format!("Could not bind BridgeLink discovery UDP {DISCOVERY_PORT}: {e}"))?;
    udp.join_multicast_v4(&DISCOVERY_ADDR, &Ipv4Addr::UNSPECIFIED)
        .map_err(|e| format!("Could not join BridgeLink multicast group: {e}"))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    {
        let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
        runtime.running = true;
        runtime.instance_id = instance_id;
        runtime.display_name = if display_name.trim().is_empty() { local_name() } else { display_name.trim().to_string() };
        runtime.platform = platform_key().to_string();
        runtime.api_port = port;
        runtime.rustdesk_id = (!rustdesk_id.trim().is_empty()).then(|| rustdesk_id.trim().to_string());
        runtime.localsend_port = if localsend_port == 0 { 53317 } else { localsend_port };
        runtime.syncthing_device_id = (!syncthing_id.trim().is_empty()).then(|| syncthing_id.trim().to_string());
        runtime.storage_dir = Some(dir);
        runtime.paired = peers;
        runtime.ai_token = ai_token;
        runtime.app = Some(app.clone());
        runtime.ai_messages = ai_messages;
        runtime.shutdown = shutdown.clone();
        runtime.detail = Some(format!("Discovering BridgeDeck peers on UDP {DISCOVERY_PORT}; API on TCP {port}"));
    }

    let manager_clone = BridgeLinkManager { inner: manager.inner.clone() };
    spawn_api(listener, manager_clone.clone(), shutdown.clone());
    spawn_discovery(udp, manager_clone, shutdown);

    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    Ok(snapshot(&mut runtime))
}

#[tauri::command]
pub fn bridgelink_stop(manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkStatus, String> {
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    runtime.shutdown.store(true, Ordering::Relaxed);
    runtime.running = false;
    runtime.detail = Some("Automatic pairing stopped".into());
    Ok(snapshot(&mut runtime))
}

#[tauri::command]
pub fn bridgelink_status(manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkStatus, String> {
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    Ok(snapshot(&mut runtime))
}

#[tauri::command]
pub fn bridgelink_request_pair(
    peer_instance_id: String,
    manager: State<'_, BridgeLinkManager>,
) -> Result<BridgeLinkStatus, String> {
    let (peer, request) = {
        let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
        let peer = runtime
            .discovered
            .get(&peer_instance_id)
            .cloned()
            .ok_or("Peer is no longer discoverable")?;
        let request_id = Uuid::new_v4().to_string();
        let issued_token = random_token();
        let code = pairing_code();
        let request = PairRequestWire {
            request_id: request_id.clone(),
            instance_id: runtime.instance_id.clone(),
            name: runtime.display_name.clone(),
            platform: runtime.platform.clone(),
            api_port: runtime.api_port,
            pairing_code: code.clone(),
            issued_token: issued_token.clone(),
            rustdesk_id: runtime.rustdesk_id.clone(),
            localsend_port: runtime.localsend_port,
            syncthing_device_id: runtime.syncthing_device_id.clone(),
        };
        runtime.outgoing = Some(OutgoingInternal {
            summary: BridgeLinkOutgoing {
                request_id,
                peer_instance_id: peer.instance_id.clone(),
                peer_name: peer.name.clone(),
                peer_platform: peer.platform.clone(),
                host: peer.host.clone(),
                api_port: peer.api_port,
                pairing_code: code,
                state: "requesting".into(),
                created_at: now_ms(),
            },
            issued_token,
        });
        (peer, request)
    };

    let body = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    let (status, response) = http_json(&peer.host, peer.api_port, "POST", "/pair/request", Some(&body))?;
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    if !(200..300).contains(&status) {
        runtime.outgoing = None;
        return Err(format!("{} rejected the pair request: HTTP {status} {response}", peer.name));
    }
    if let Some(outgoing) = runtime.outgoing.as_mut() {
        outgoing.summary.state = "waiting".into();
    }
    runtime.detail = Some(format!("Pair request sent to {}", peer.name));
    Ok(snapshot(&mut runtime))
}

#[tauri::command]
pub fn bridgelink_poll_pair(manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkPairResult, String> {
    let outgoing = {
        let runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
        runtime.outgoing.clone().ok_or("No outgoing pairing request")?
    };
    let target = format!("/pair/status?requestId={}", outgoing.summary.request_id);
    let (status, body) = http_json(&outgoing.summary.host, outgoing.summary.api_port, "GET", &target, None)?;
    if status != 200 {
        return Err(format!("Pair status failed with HTTP {status}: {body}"));
    }
    let response: PairStatusWire = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if response.status == "pending" || response.status == "unknown" {
        let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
        if let Some(active) = runtime.outgoing.as_mut() {
            active.summary.state = "waiting".into();
        }
        return Ok(BridgeLinkPairResult { paired: false, peer: None, detail: "Waiting for approval on the other computer".into() });
    }
    if response.status == "declined" {
        let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
        runtime.outgoing = None;
        runtime.detail = Some(format!("{} declined pairing", outgoing.summary.peer_name));
        return Ok(BridgeLinkPairResult { paired: false, peer: None, detail: "Pairing was declined".into() });
    }
    if response.status != "approved" {
        return Err(response.detail.unwrap_or_else(|| format!("Unexpected pairing status: {}", response.status)));
    }
    let access_token = response.issued_token.ok_or("Approved response did not contain an access token")?;
    let peer = PersistedPeer {
        instance_id: outgoing.summary.peer_instance_id.clone(),
        name: response.name.unwrap_or_else(|| outgoing.summary.peer_name.clone()),
        platform: response.platform.unwrap_or_else(|| outgoing.summary.peer_platform.clone()),
        host: outgoing.summary.host.clone(),
        api_port: response.api_port.unwrap_or(outgoing.summary.api_port),
        access_token,
        issued_token: outgoing.issued_token.clone(),
        rustdesk_peer_id: response.rustdesk_id.filter(|v| !v.trim().is_empty()),
        localsend_port: response.localsend_port.unwrap_or(53317),
        syncthing_device_id: response.syncthing_device_id.filter(|v| !v.trim().is_empty()),
        bluebubbles_port: None, // learned on the first status refresh
        paired_at: now_ms(),
    };
    let public = peer.public();
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    runtime.paired.insert(peer.instance_id.clone(), peer);
    runtime.outgoing = None;
    runtime.detail = Some(format!("Paired with {}", public.name));
    save_peers(&runtime)?;
    Ok(BridgeLinkPairResult { paired: true, peer: Some(public), detail: "Pairing complete".into() })
}

#[tauri::command]
pub fn bridgelink_approve(
    request_id: String,
    manager: State<'_, BridgeLinkManager>,
) -> Result<BridgeLinkPairResult, String> {
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    let pending = runtime.pending.remove(&request_id).ok_or("Pair request is no longer pending")?;
    let issued_token = random_token();
    let peer = PersistedPeer {
        instance_id: pending.request.instance_id.clone(),
        name: pending.request.name.clone(),
        platform: pending.request.platform.clone(),
        host: pending.host.clone(),
        api_port: pending.request.api_port,
        access_token: pending.request.issued_token.clone(),
        issued_token: issued_token.clone(),
        rustdesk_peer_id: pending.request.rustdesk_id.clone().filter(|v| !v.trim().is_empty()),
        localsend_port: pending.request.localsend_port,
        syncthing_device_id: pending.request.syncthing_device_id.clone().filter(|v| !v.trim().is_empty()),
        bluebubbles_port: None, // learned on the first status refresh
        paired_at: now_ms(),
    };
    let public = peer.public();
    runtime.paired.insert(peer.instance_id.clone(), peer);
    let local_name = runtime.display_name.clone();
    let local_platform = runtime.platform.clone();
    let local_api_port = runtime.api_port;
    let local_rustdesk_id = runtime.rustdesk_id.clone();
    let local_localsend_port = runtime.localsend_port;
    let local_syncthing_device_id = runtime.syncthing_device_id.clone();
    runtime.outcomes.insert(
        request_id,
        PairStatusWire {
            status: "approved".into(),
            name: Some(local_name),
            platform: Some(local_platform),
            api_port: Some(local_api_port),
            issued_token: Some(issued_token),
            rustdesk_id: local_rustdesk_id,
            localsend_port: Some(local_localsend_port),
            syncthing_device_id: local_syncthing_device_id,
            detail: Some("Pairing approved".into()),
        },
    );
    runtime.detail = Some(format!("Paired with {}", public.name));
    save_peers(&runtime)?;
    Ok(BridgeLinkPairResult { paired: true, peer: Some(public), detail: "Pairing approved".into() })
}

#[tauri::command]
pub fn bridgelink_decline(
    request_id: String,
    manager: State<'_, BridgeLinkManager>,
) -> Result<BridgeLinkStatus, String> {
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    let pending = runtime.pending.remove(&request_id).ok_or("Pair request is no longer pending")?;
    let local_name = runtime.display_name.clone();
    runtime.outcomes.insert(
        request_id,
        PairStatusWire {
            status: "declined".into(),
            name: None,
            platform: None,
            api_port: None,
            issued_token: None,
            rustdesk_id: None,
            localsend_port: None,
            syncthing_device_id: None,
            detail: Some(format!("{local_name} declined the request")),
        },
    );
    runtime.detail = Some(format!("Declined pairing from {}", pending.request.name));
    Ok(snapshot(&mut runtime))
}

#[tauri::command]
pub fn bridgelink_forget(
    instance_id: String,
    manager: State<'_, BridgeLinkManager>,
) -> Result<BridgeLinkStatus, String> {
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    runtime.paired.remove(&instance_id);
    save_peers(&runtime)?;
    runtime.detail = Some("Paired computer removed".into());
    Ok(snapshot(&mut runtime))
}

fn http_json_bearer(
    host: &str,
    port: u16,
    method: &str,
    target: &str,
    token: &str,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    http_json_bearer_timeout(host, port, method, target, token, body, Duration::from_secs(4))
}

/// `read_timeout` covers the peer's processing time (long for requests that wait on the user, such as the
/// macOS Contacts permission prompt). Connecting always fails fast so an asleep peer doesn't stall callers.
fn http_json_bearer_timeout(
    host: &str,
    port: u16,
    method: &str,
    target: &str,
    token: &str,
    body: Option<&str>,
    read_timeout: Duration,
) -> Result<(u16, String), String> {
    use std::net::ToSocketAddrs;
    let addr = (host, port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("Could not resolve peer address")?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| format!("Could not reach BridgeDeck at {host}:{port}: {e}"))?;
    stream.set_read_timeout(Some(read_timeout)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(4))).map_err(|e| e.to_string())?;
    let body = body.unwrap_or("");
    let request = format!(
        "{method} {target} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        format_host_port(host, port), token, body.as_bytes().len(), body
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8(raw).map_err(|e| e.to_string())?;
    let (head, body) = text.split_once("\r\n\r\n").ok_or("Invalid BridgeLink response")?;
    let code = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or("Invalid BridgeLink response status")?;
    Ok((code, body.to_string()))
}

/// Async so a slow or offline peer (4 s socket timeouts) never blocks the UI thread;
/// the app now calls this on every status refresh.
#[tauri::command]
pub async fn bridgelink_refresh_peer(
    instance_id: String,
    manager: State<'_, BridgeLinkManager>,
) -> Result<BridgeLinkPairResult, String> {
    let manager = BridgeLinkManager { inner: manager.inner.clone() };
    tauri::async_runtime::spawn_blocking(move || refresh_peer_blocking(&manager, instance_id))
        .await
        .map_err(|e| e.to_string())?
}

fn refresh_peer_blocking(manager: &BridgeLinkManager, instance_id: String) -> Result<BridgeLinkPairResult, String> {
    let peer = {
        let runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
        runtime.paired.get(&instance_id).cloned().ok_or("Paired computer not found")?
    };
    let (status, body) = http_json_bearer(&peer.host, peer.api_port, "GET", "/status", &peer.access_token, None)?;
    if status != 200 {
        return Err(format!("Could not refresh paired computer: HTTP {status} {body}"));
    }
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    let stored = runtime.paired.get_mut(&instance_id).ok_or("Paired computer disappeared")?;
    if let Some(name) = value.get("hostname").and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty()) {
        stored.name = name.to_string();
    }
    if let Some(platform) = value.get("platform").and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty()) {
        stored.platform = platform.to_string();
    }
    if let Some(id) = value.get("rustdeskPeerId").and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty()) {
        stored.rustdesk_peer_id = Some(id.to_string());
    }
    if let Some(port) = value.get("localsendPort").and_then(|v| v.as_u64()).and_then(|v| u16::try_from(v).ok()) {
        stored.localsend_port = port;
    }
    if let Some(id) = value.get("syncthingDeviceId").and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty()) {
        stored.syncthing_device_id = Some(id.to_string());
    }
    // Present-or-absent on every refresh: the server can be stopped or started at any time.
    stored.bluebubbles_port = value.get("bluebubblesPort").and_then(|v| v.as_u64()).and_then(|v| u16::try_from(v).ok());
    let public = stored.public();
    save_peers(&runtime)?;
    Ok(BridgeLinkPairResult {
        paired: true,
        peer: Some(public),
        detail: "Paired computer metadata refreshed".into(),
    })
}

#[tauri::command]
pub fn bridgelink_ai_messages(since: u64, manager: State<'_, BridgeLinkManager>) -> Result<Vec<AiMessage>, String> {
    let runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    Ok(ai_messages_since(&runtime, since, None))
}

#[tauri::command]
pub async fn bridgelink_ai_send(
    author: String,
    body: String,
    channel: Option<String>,
    manager: State<'_, BridgeLinkManager>,
) -> Result<AiMessage, String> {
    let manager = BridgeLinkManager { inner: manager.inner.clone() };
    tauri::async_runtime::spawn_blocking(move || {
        ai_send_internal(&manager, AiSendWire { author, body, channel, reply_to: None, peer_instance_id: None })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Path of the local AI token file, shown in the UI so AI CLIs can be pointed at it.
#[tauri::command]
pub fn bridgelink_ai_token_path(manager: State<'_, BridgeLinkManager>) -> Result<String, String> {
    let runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    let dir = runtime.storage_dir.as_ref().ok_or("BridgeLink is not started")?;
    Ok(dir.join("ai-token").to_string_lossy().to_string())
}
/// A contact edit for the Mac's Contacts app. Only the listed values change: `*_remove` entries are
/// deleted by exact value, `*_add` entries are appended; everything else (and existing labels) is kept.
/// `person_id` is the Contacts identifier ("<UUID>:ABPerson", as BlueBubbles reports it); empty = new contact.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContactSaveRequest {
    pub person_id: String,
    pub first_name: String,
    pub last_name: String,
    pub phones_add: Vec<String>,
    pub phones_remove: Vec<String>,
    pub emails_add: Vec<String>,
    pub emails_remove: Vec<String>,
}

impl ContactSaveRequest {
    pub fn validate(&self) -> Result<(), String> {
        let id_ok = self.person_id.is_empty()
            || (self.person_id.len() <= 80
                && self.person_id.ends_with(":ABPerson")
                && self.person_id.trim_end_matches(":ABPerson").chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        if !id_ok {
            return Err("Invalid contact id".into());
        }
        if self.first_name.trim().is_empty() && self.last_name.trim().is_empty() {
            return Err("A contact needs a first or last name".into());
        }
        let lists = [&self.phones_add, &self.phones_remove, &self.emails_add, &self.emails_remove];
        let too_long = |s: &String| s.chars().count() > 120 || s.contains('\n') || s.contains('\r');
        if self.first_name.chars().count() > 100 || self.last_name.chars().count() > 100
            || self.first_name.contains('\n') || self.last_name.contains('\n')
            || lists.iter().any(|l| l.len() > 20 || l.iter().any(too_long))
        {
            return Err("Contact fields are too long".into());
        }
        Ok(())
    }
}

/// Sends a contact edit to the paired Mac, which saves it in its Contacts app (synced via iCloud).
pub fn forward_contact_save(manager: &BridgeLinkManager, request: &ContactSaveRequest) -> Result<String, String> {
    request.validate()?;
    let peer = {
        let runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
        runtime.paired.values().find(|p| p.platform == "macos").cloned().ok_or("No paired Mac to save the contact on")?
    };
    let body = serde_json::to_string(request).map_err(|e| e.to_string())?;
    // Generous read timeout: the first save waits for the user to allow Contacts access on the Mac.
    let (status, response) = http_json_bearer_timeout(&peer.host, peer.api_port, "POST", "/contacts/save", &peer.access_token, Some(&body), Duration::from_secs(90))?;
    let value: serde_json::Value = serde_json::from_str(&response).unwrap_or(serde_json::Value::Null);
    if status == 404 {
        return Err(format!("{} does not support contact editing yet (update BridgeDeck there)", peer.name));
    }
    if !(200..300).contains(&status) || value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(value.get("error").and_then(|v| v.as_str()).map(str::to_string).unwrap_or_else(|| format!("{} returned HTTP {status}", peer.name)));
    }
    Ok(value.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string())
}
/// Remote contact edits: one at a time, at most 10 per 10 minutes.
const CONTACT_EDIT_LIMIT: usize = 10;
const CONTACT_EDIT_WINDOW: Duration = Duration::from_secs(600);

fn reserve_contact_edit(manager: &BridgeLinkManager) -> Result<(), String> {
    let mut runtime = manager.inner.lock().map_err(|_| "BridgeLink state lock poisoned")?;
    if runtime.contact_edit_busy {
        return Err("Another contact change is waiting for approval on the Mac".into());
    }
    let now = Instant::now();
    runtime.contact_edits.retain(|at| now.duration_since(*at) < CONTACT_EDIT_WINDOW);
    if runtime.contact_edits.len() >= CONTACT_EDIT_LIMIT {
        return Err("Too many contact changes; try again in a few minutes".into());
    }
    runtime.contact_edits.push(now);
    runtime.contact_edit_busy = true;
    Ok(())
}

fn release_contact_edit(manager: &BridgeLinkManager) {
    if let Ok(mut runtime) = manager.inner.lock() {
        runtime.contact_edit_busy = false;
    }
}

/// Asks the user on this computer to approve a contact change requested by the paired computer.
/// Denies after 60 s without an answer.
fn confirm_remote_contact_edit(app: &AppHandle, peer_name: &str, req: &ContactSaveRequest) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let name = format!("{} {}", req.first_name.trim(), req.last_name.trim()).trim().to_string();
    let mut lines = vec![format!("{peer_name} wants to {} “{name}” in Contacts.", if req.person_id.is_empty() { "create" } else { "change" })];
    let list = |label: &str, values: &[String], lines: &mut Vec<String>| if !values.is_empty() { lines.push(format!("{label}: {}", values.join(", "))) };
    list("Add phone", &req.phones_add, &mut lines);
    list("Remove phone", &req.phones_remove, &mut lines);
    list("Add email", &req.emails_add, &mut lines);
    list("Remove email", &req.emails_remove, &mut lines);
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(lines.join("\n"))
        .title("Allow contact change?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Deny".into()))
        .show(move |allowed| { let _ = tx.send(allowed); });
    rx.recv_timeout(Duration::from_secs(60)).unwrap_or(false)
}
