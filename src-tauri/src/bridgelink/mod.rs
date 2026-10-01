//! BridgeLink: how BridgeDeck finds, pairs with and talks to the user's other devices.
//!
//! v2 (0.9): paired devices talk over QUIC with pinned self-signed certificates (`crate::link`);
//! pairing compares a six-digit code derived from both certificates on both screens, and no bearer
//! token ever crosses the network. The HTTP API is loopback-only, for this computer's AI tools and
//! BridgeDeck's own status. See `docs/ROADMAP.md` Phase 1.
//!
//! - `peer`: requests between paired devices, and pairing.
//! - `discovery`: LAN multicast and Tailscale announcements.
//! - `local`: the loopback HTTP API.
//! - `workspace`: the AI workspace (agents, rooms, tasks, file claims).

mod discovery;
pub mod calendar;
pub mod notes;
mod local;
pub(crate) mod peer;
pub(crate) mod workspace;

pub use peer::{forward_contact_save, forward_upgrade_request, peer_upgrade_status, ContactSaveRequest, UpgradeRequest};

use crate::link::{identity::Identity, transport::Link};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs},
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

pub const PROTOCOL_VERSION: u8 = 2;
const DEFAULT_API_PORT: u16 = 41416;
const MAX_PENDING: usize = 20;
const MAX_AI_MESSAGES: usize = 500;
const MAX_AI_BODY: usize = 24 * 1024;
const DEFAULT_AI_CHANNEL: &str = "shared-agents";
/// What this build can do for a paired device; reported in `/status`.
#[cfg(target_os = "macos")]
pub const CAPABILITIES: &[&str] = &["status", "ai", "ai-workspace", "contacts", "upgrade", "messages", "clipboard", "notes", "calendar"];
#[cfg(not(target_os = "macos"))]
pub const CAPABILITIES: &[&str] = &["status", "ai", "ai-workspace", "contacts", "upgrade", "clipboard", "notes", "calendar"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkPeer {
    pub instance_id: String,
    pub name: String,
    pub platform: String,
    pub host: String,
    pub api_port: u16,
    /// 1 = BridgeDeck 0.8 or older (must be updated before it can pair), 2 = current.
    pub protocol: u8,
    /// Where it was seen: "lan" or "tailscale".
    pub via: String,
    pub last_seen: u64,
}

/// A pairing started by another device, shown with its code until both people confirm.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkPending {
    pub request_id: String,
    pub peer_instance_id: String,
    pub peer_name: String,
    pub peer_platform: String,
    pub host: String,
    pub pairing_code: String,
    /// "waiting" (for this computer's answer) or "approved" (waiting for the other computer).
    pub state: String,
    pub created_at: u64,
}

/// A pairing this computer started.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkOutgoing {
    pub request_id: String,
    pub peer_instance_id: String,
    pub peer_name: String,
    pub peer_platform: String,
    pub host: String,
    /// Empty until the secure exchange finishes.
    pub pairing_code: String,
    /// "connecting" | "confirm" (compare codes) | "waiting" (confirmed here) | "failed"
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
    /// SHA-256 of the device's certificate, pinned at pairing.
    pub fingerprint: String,
    pub localsend_target: String,
    pub syncthing_device_id: Option<String>,
    /// "lan" or "tailscale": the network the current address belongs to.
    pub via: String,
    pub paired_at: u64,
    /// It reported a hardware address, so Wake-on-LAN can be tried.
    pub wakeable: bool,
    /// Every IP address it has been reached at (current first), e.g. to trust its file transfers.
    pub addresses: Vec<String>,
}

/// A device paired with BridgeDeck 0.8 or older. Its pairing can't be used any more (it relied on
/// plaintext tokens); it must be paired again, and can be asked to update first.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkLegacyPeer {
    pub instance_id: String,
    pub name: String,
    pub platform: String,
    pub host: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLinkStatus {
    pub running: bool,
    pub instance_id: String,
    pub display_name: String,
    pub platform: String,
    pub api_port: u16,
    pub fingerprint: String,
    pub tailscale: bool,
    pub discovered: Vec<BridgeLinkPeer>,
    pub pending: Vec<BridgeLinkPending>,
    pub outgoing: Option<BridgeLinkOutgoing>,
    pub paired: Vec<BridgeLinkPairedPeer>,
    pub legacy: Vec<BridgeLinkLegacyPeer>,
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
    /// Outgoing message waiting for the other computer to come online.
    #[serde(default)]
    pub pending: bool,
    /// Agent names it's addressed to; empty = everyone.
    #[serde(default)]
    pub to: Vec<String>,
    /// The workspace room it belongs to, if any.
    #[serde(default)]
    pub room: Option<String>,
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
    #[serde(default)]
    to: Vec<String>,
    #[serde(default)]
    room: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSendWire {
    author: String,
    body: String,
    channel: Option<String>,
    reply_to: Option<String>,
    peer_instance_id: Option<String>,
    #[serde(default)]
    to: Vec<String>,
    #[serde(default)]
    room: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutboxItem {
    peer_instance_id: String,
    wire: AiInboxWire,
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
    fingerprint: String,
    localsend_port: u16,
    syncthing_device_id: Option<String>,
    paired_at: u64,
    /// Hardware addresses it reported while awake, for Wake-on-LAN.
    #[serde(default)]
    mac_addresses: Vec<String>,
}

impl PersistedPeer {
    fn public(&self) -> BridgeLinkPairedPeer {
        BridgeLinkPairedPeer {
            instance_id: self.instance_id.clone(),
            name: self.name.clone(),
            platform: self.platform.clone(),
            host: self.host.clone(),
            api_port: self.api_port,
            fingerprint: self.fingerprint.clone(),
            localsend_target: format_host_port(&self.host, self.localsend_port),
            syncthing_device_id: self.syncthing_device_id.clone(),
            via: if is_tailscale_host(&self.host) { "tailscale" } else { "lan" }.into(),
            paired_at: self.paired_at,
            wakeable: !self.mac_addresses.is_empty(),
            addresses: Vec::new(),
        }
    }
}

/// A peer record from BridgeDeck 0.8 or older (`peers.json`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPeer {
    instance_id: String,
    name: String,
    platform: String,
    host: String,
    api_port: u16,
    access_token: String,
}

/// A pairing in progress, from either side.
struct PairingState {
    request_id: String,
    peer_instance_id: String,
    peer_name: String,
    peer_platform: String,
    host: String,
    code: String,
    /// This computer's person: None until they answer.
    local: Option<bool>,
    created_at: u64,
}

struct Runtime {
    running: bool,
    instance_id: String,
    display_name: String,
    platform: String,
    api_port: u16,
    localsend_port: u16,
    syncthing_device_id: Option<String>,
    discovered: HashMap<String, BridgeLinkPeer>,
    /// Addresses each device was recently seen at (host, when, via Tailscale).
    seen: HashMap<String, Vec<(String, u64, bool)>>,
    /// Tailscale peers to announce to (refreshed from `tailscale status`).
    tailscale_targets: Vec<IpAddr>,
    incoming: HashMap<String, PairingState>,
    outgoing: Option<(PairingState, String)>,
    /// Finished pairings not yet reported to the UI by `bridgelink_poll_pair`.
    pair_results: Vec<BridgeLinkPairResult>,
    paired: HashMap<String, PersistedPeer>,
    legacy: HashMap<String, LegacyPeer>,
    ai_messages: Vec<AiMessage>,
    outbox: Vec<OutboxItem>,
    workspace: workspace::Workspace,
    notes: notes::NoteStore,
    calendar: calendar::CalendarStore,
    ai_token: String,
    link: Option<Arc<Link>>,
    fingerprint: String,
    /// For desktop notifications, dialogs and UI events.
    app: Option<AppHandle>,
    /// Remote contact-edit rate limiting (see `peer::reserve_contact_edit`).
    contact_edits: Vec<Instant>,
    contact_edit_busy: bool,
    shutdown: Arc<AtomicBool>,
    storage_dir: Option<PathBuf>,
    detail: Option<String>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            running: false,
            instance_id: String::new(),
            display_name: "BridgeDeck".to_string(),
            platform: platform_key().to_string(),
            api_port: DEFAULT_API_PORT,
            localsend_port: 53317,
            syncthing_device_id: None,
            discovered: HashMap::new(),
            seen: HashMap::new(),
            tailscale_targets: Vec::new(),
            incoming: HashMap::new(),
            outgoing: None,
            pair_results: Vec::new(),
            paired: HashMap::new(),
            legacy: HashMap::new(),
            ai_messages: Vec::new(),
            outbox: Vec::new(),
            workspace: workspace::Workspace::default(),
            notes: notes::NoteStore::default(),
            calendar: calendar::CalendarStore::default(),
            ai_token: String::new(),
            link: None,
            fingerprint: String::new(),
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
    inner: Arc<Mutex<Runtime>>,
}

impl BridgeLinkManager {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Runtime>, String> {
        self.inner.lock().map_err(|_| "BridgeLink state lock poisoned".to_string())
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
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
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(var) {
            if !value.trim().is_empty() {
                return value;
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(output) = Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && !value.is_empty() {
            return value;
        }
    }
    if let Ok(output) = Command::new("hostname").output() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && !value.is_empty() {
            return value;
        }
    }
    "BridgeDeck".to_string()
}

fn storage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("bridgelink");
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

fn load_or_create_instance_id(dir: &Path) -> Result<String, String> {
    let path = dir.join("identity.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<IdentityFile>(&raw) {
            if !parsed.instance_id.trim().is_empty() {
                return Ok(parsed.instance_id);
            }
        }
    }
    let identity = IdentityFile { instance_id: Uuid::new_v4().to_string() };
    secure_write(&path, &serde_json::to_string_pretty(&identity).map_err(|e| e.to_string())?)?;
    Ok(identity.instance_id)
}

fn load_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn load_peers(dir: &Path) -> HashMap<String, PersistedPeer> {
    load_json::<Vec<PersistedPeer>>(&dir.join("peers-v2.json"))
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.instance_id.clone(), p))
        .collect()
}

/// 0.8 and older pairings, kept only so the UI can say which devices need pairing again.
fn load_legacy(dir: &Path, paired: &HashMap<String, PersistedPeer>) -> HashMap<String, LegacyPeer> {
    load_json::<Vec<LegacyPeer>>(&dir.join("peers.json"))
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !paired.contains_key(&p.instance_id))
        .map(|p| (p.instance_id.clone(), p))
        .collect()
}

fn save_peers(runtime: &Runtime) -> Result<(), String> {
    let dir = runtime.storage_dir.as_ref().ok_or("BridgeLink storage is not initialized")?;
    let mut list: Vec<&PersistedPeer> = runtime.paired.values().collect();
    list.sort_by_key(|p| p.name.to_lowercase());
    secure_write(&dir.join("peers-v2.json"), &serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?)
}

fn save_legacy(runtime: &Runtime) {
    let Some(dir) = runtime.storage_dir.as_ref() else { return };
    let list: Vec<&LegacyPeer> = runtime.legacy.values().collect();
    if let Ok(raw) = serde_json::to_string_pretty(&list) {
        let _ = secure_write(&dir.join("peers.json"), &raw);
    }
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
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    secure_write(&path, &token)?;
    Ok(token)
}

/// The relay log is append-only; a message delivered after being queued appears twice, and the
/// later line (with `pending: false`) wins.
fn load_ai_messages(dir: &Path) -> Vec<AiMessage> {
    let Ok(raw) = fs::read_to_string(dir.join("ai-messages.jsonl")) else { return Vec::new() };
    let mut list: Vec<AiMessage> = Vec::new();
    for message in raw.lines().filter_map(|line| serde_json::from_str::<AiMessage>(line).ok()) {
        match list.iter_mut().find(|m| m.id == message.id) {
            Some(existing) => *existing = message,
            None => list.push(message),
        }
    }
    if list.len() > MAX_AI_MESSAGES || raw.lines().count() > list.len() {
        let start = list.len().saturating_sub(MAX_AI_MESSAGES);
        list.drain(..start);
        let compacted: Vec<String> = list.iter().filter_map(|m| serde_json::to_string(m).ok()).collect();
        let _ = secure_write(&dir.join("ai-messages.jsonl"), &(compacted.join("\n") + "\n"));
    }
    list
}

fn append_ai_log(runtime: &Runtime, message: &AiMessage) {
    let Some(dir) = runtime.storage_dir.as_ref() else { return };
    let Ok(line) = serde_json::to_string(message) else { return };
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

fn record_ai_message(runtime: &mut Runtime, message: AiMessage) {
    append_ai_log(runtime, &message);
    runtime.ai_messages.push(message);
    if runtime.ai_messages.len() > MAX_AI_MESSAGES {
        let excess = runtime.ai_messages.len() - MAX_AI_MESSAGES;
        runtime.ai_messages.drain(..excess);
    }
}

fn save_outbox(runtime: &Runtime) {
    let Some(dir) = runtime.storage_dir.as_ref() else { return };
    if let Ok(raw) = serde_json::to_string(&runtime.outbox) {
        let _ = secure_write(&dir.join("outbox.json"), &raw);
    }
}

/// AI messages show a desktop notification (Settings → Notifications).
pub static AI_NOTIFICATIONS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Desktop notification plus a UI event for an incoming relay message.
fn notify_ai_message(app: &AppHandle, message: &AiMessage) {
    use tauri::Emitter;
    use tauri_plugin_notification::NotificationExt;
    let _ = app.emit("ai-message", message);
    if !AI_NOTIFICATIONS.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let preview: String = message.body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(180).collect();
    let _ = app.notification().builder().title(format!("{} · {}", message.author, message.peer_name)).body(preview).show();
}

/// Keeps author/channel labels short and printable; they are shown in UIs and prompts.
fn clean_label(value: &str, fallback: &str) -> String {
    let cleaned: String = value.trim().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).take(32).collect();
    if cleaned.is_empty() { fallback.to_string() } else { cleaned }
}

fn clean_id(value: &str) -> Option<String> {
    let cleaned: String = value.trim().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Device names and platforms from the network are shown in the UI and dialogs.
fn clean_text(value: &str, fallback: &str, max: usize) -> String {
    let cleaned: String = value.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string();
    if cleaned.is_empty() { fallback.to_string() } else { cleaned }
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

fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

/// Tailscale gives each device an address in 100.64.0.0/10 (CGNAT space).
pub(crate) fn is_tailscale_host(host: &str) -> bool {
    matches!(host.parse::<IpAddr>(), Ok(IpAddr::V4(ip)) if ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1]))
}

/// Where to reach a paired device: its current address first, then any other address it was seen at
/// recently (LAN before Tailscale).
fn peer_addresses(runtime: &Runtime, peer: &PersistedPeer) -> Vec<SocketAddr> {
    let mut hosts = vec![peer.host.clone()];
    if let Some(seen) = runtime.seen.get(&peer.instance_id) {
        let mut others: Vec<_> = seen.iter().filter(|(h, _, _)| *h != peer.host).collect();
        others.sort_by_key(|(_, at, tailscale)| (*tailscale, std::cmp::Reverse(*at)));
        hosts.extend(others.into_iter().map(|(h, _, _)| h.clone()));
    }
    let mut addresses = Vec::new();
    for host in hosts {
        if let Ok(resolved) = (host.as_str(), peer.api_port).to_socket_addrs() {
            for address in resolved.filter(|a| a.is_ipv4()) {
                if !addresses.contains(&address) {
                    addresses.push(address);
                }
            }
        }
    }
    addresses
}

fn snapshot(runtime: &mut Runtime) -> BridgeLinkStatus {
    let now = now_ms();
    runtime.discovered.retain(|_, peer| now.saturating_sub(peer.last_seen) <= discovery::PEER_STALE_MS);
    runtime.incoming.retain(|_, p| now.saturating_sub(p.created_at) <= peer::PAIRING_TIMEOUT.as_millis() as u64);

    let mut discovered: Vec<_> = runtime.discovered.values().cloned().collect();
    discovered.sort_by_key(|p| p.name.to_lowercase());
    let mut pending: Vec<_> = runtime
        .incoming
        .values()
        .map(|p| BridgeLinkPending {
            request_id: p.request_id.clone(),
            peer_instance_id: p.peer_instance_id.clone(),
            peer_name: p.peer_name.clone(),
            peer_platform: p.peer_platform.clone(),
            host: p.host.clone(),
            pairing_code: p.code.clone(),
            state: if p.local == Some(true) { "approved" } else { "waiting" }.into(),
            created_at: p.created_at,
        })
        .collect();
    pending.sort_by_key(|p| p.created_at);
    let mut paired: Vec<_> = runtime
        .paired
        .values()
        .map(|p| {
            let mut public = p.public();
            // IP literals only: this runs on every status refresh, so no name lookups.
            let seen = runtime.seen.get(&p.instance_id).into_iter().flatten().map(|(host, _, _)| host);
            for host in std::iter::once(&p.host).chain(seen) {
                if let Ok(ip) = host.trim_matches(['[', ']']).parse::<std::net::IpAddr>() {
                    let ip = ip.to_canonical().to_string();
                    if !public.addresses.contains(&ip) {
                        public.addresses.push(ip);
                    }
                }
            }
            public
        })
        .collect();
    paired.sort_by_key(|p| p.name.to_lowercase());
    let mut legacy: Vec<_> = runtime
        .legacy
        .values()
        .map(|p| BridgeLinkLegacyPeer { instance_id: p.instance_id.clone(), name: p.name.clone(), platform: p.platform.clone(), host: p.host.clone() })
        .collect();
    legacy.sort_by_key(|p| p.name.to_lowercase());

    BridgeLinkStatus {
        running: runtime.running,
        instance_id: runtime.instance_id.clone(),
        display_name: runtime.display_name.clone(),
        platform: runtime.platform.clone(),
        api_port: runtime.api_port,
        fingerprint: runtime.fingerprint.clone(),
        tailscale: !runtime.tailscale_targets.is_empty(),
        discovered,
        pending,
        outgoing: runtime.outgoing.as_ref().map(|(p, state)| BridgeLinkOutgoing {
            request_id: p.request_id.clone(),
            peer_instance_id: p.peer_instance_id.clone(),
            peer_name: p.peer_name.clone(),
            peer_platform: p.peer_platform.clone(),
            host: p.host.clone(),
            pairing_code: p.code.clone(),
            state: state.clone(),
            created_at: p.created_at,
        }),
        paired,
        legacy,
        detail: runtime.detail.clone(),
    }
}

/// This computer's status, for its own UI (loopback) and for paired devices.
fn status_body(runtime: &Runtime) -> String {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL_VERSION,
        "capabilities": CAPABILITIES,
        "hostname": runtime.display_name,
        "platform": runtime.platform,
        "arch": std::env::consts::ARCH,
        "uptimeSeconds": sysinfo::System::uptime(),
        "totalMemory": system.total_memory(),
        "freeMemory": system.available_memory(),
        "timestamp": now_ms().to_string(),
        "bridgeInstanceId": runtime.instance_id,
        "localsendPort": runtime.localsend_port,
        "syncthingDeviceId": runtime.syncthing_device_id,
        "macAddresses": crate::wake::local_macs(),
    })
    .to_string()
}

/// Which relay messages a reader wants.
#[derive(Default)]
struct AiFilter<'a> {
    channel: Option<&'a str>,
    /// Only messages for this agent (see `workspace::is_for`).
    agent: Option<&'a str>,
    room: Option<&'a str>,
}

fn ai_messages_since(runtime: &Runtime, since: u64, filter: &AiFilter) -> Vec<AiMessage> {
    runtime
        .ai_messages
        .iter()
        .filter(|m| {
            m.created_at > since
                && filter.channel.is_none_or(|c| m.channel == c)
                && filter.room.is_none_or(|r| m.room.as_deref() == Some(r))
                && filter.agent.is_none_or(|a| workspace::is_for(m, a))
        })
        .cloned()
        .collect()
}

/// Records an outgoing message and delivers it to every paired device (or the one named). Devices
/// that can't be reached get it queued, delivered when they come back (see `flush_outbox`). With no
/// paired device the message stays on this computer, for agents here.
fn ai_send_internal(manager: &BridgeLinkManager, send: AiSendWire) -> Result<AiMessage, String> {
    validate_ai_body(&send.body)?;
    let targets: Vec<PersistedPeer> = {
        let runtime = manager.lock()?;
        if !runtime.running {
            return Err("BridgeLink is not running".into());
        }
        match send.peer_instance_id.as_deref().filter(|v| !v.trim().is_empty()) {
            Some(id) => vec![runtime.paired.get(id).cloned().ok_or("Paired computer not found")?],
            None => {
                let mut peers: Vec<_> = runtime.paired.values().cloned().collect();
                peers.sort_by_key(|p| p.name.to_lowercase());
                peers
            }
        }
    };
    let mut to: Vec<String> = send.to.iter().filter(|t| !t.trim().is_empty()).take(20).map(|t| clean_label(t, "agent")).collect();
    to.dedup();
    let wire = AiInboxWire {
        id: Uuid::new_v4().to_string(),
        channel: clean_label(send.channel.as_deref().unwrap_or(""), DEFAULT_AI_CHANNEL),
        author: clean_label(&send.author, "agent"),
        body: send.body,
        reply_to: send.reply_to.filter(|v| !v.trim().is_empty()),
        created_at: now_ms(),
        to,
        room: send.room.as_deref().and_then(clean_id),
    };
    let mut queued: Vec<String> = Vec::new();
    let mut rejected: Vec<String> = Vec::new();
    for peer in &targets {
        match peer::deliver_ai(manager, &peer.instance_id, &wire) {
            Ok(()) => {}
            Err(peer::Delivery::Unreachable(_)) => queued.push(peer.instance_id.clone()),
            Err(peer::Delivery::Rejected(error)) => rejected.push(format!("{}: {error}", peer.name)),
        }
    }
    if !targets.is_empty() && rejected.len() == targets.len() {
        return Err(rejected.join("; "));
    }
    let message = AiMessage {
        id: wire.id.clone(),
        channel: wire.channel.clone(),
        author: wire.author.clone(),
        body: wire.body.clone(),
        reply_to: wire.reply_to.clone(),
        direction: "out".into(),
        peer_instance_id: if targets.len() == 1 { targets[0].instance_id.clone() } else { String::new() },
        peer_name: if targets.is_empty() { "this computer".into() } else { targets.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ") },
        created_at: wire.created_at,
        pending: !queued.is_empty(),
        to: wire.to.clone(),
        room: wire.room.clone(),
    };
    let mut runtime = manager.lock()?;
    if !queued.is_empty() {
        for peer_instance_id in queued {
            runtime.outbox.push(OutboxItem { peer_instance_id, wire: wire.clone() });
        }
        save_outbox(&runtime);
    }
    record_ai_message(&mut runtime, message.clone());
    if let Some(app) = runtime.app.clone() {
        use tauri::Emitter;
        let _ = app.emit("ai-message", &message);
    }
    Ok(message)
}

/// Retries queued relay messages. Messages older than a day are dropped from the queue (they stay in
/// the log, still marked pending).
fn flush_outbox(manager: &BridgeLinkManager) {
    let items = match manager.lock() {
        Ok(mut runtime) => {
            let cutoff = now_ms().saturating_sub(24 * 60 * 60_000);
            runtime.outbox.retain(|item| item.wire.created_at >= cutoff);
            runtime.outbox.clone()
        }
        Err(_) => return,
    };
    let mut unreachable: Vec<String> = Vec::new();
    for item in items {
        if unreachable.contains(&item.peer_instance_id) {
            continue;
        }
        match peer::deliver_ai(manager, &item.peer_instance_id, &item.wire) {
            Ok(()) | Err(peer::Delivery::Rejected(_)) => {
                let Ok(mut runtime) = manager.lock() else { return };
                runtime.outbox.retain(|queued| !(queued.wire.id == item.wire.id && queued.peer_instance_id == item.peer_instance_id));
                save_outbox(&runtime);
                let still_queued = runtime.outbox.iter().any(|queued| queued.wire.id == item.wire.id);
                if still_queued {
                    continue;
                }
                if let Some(index) = runtime.ai_messages.iter().position(|m| m.id == item.wire.id) {
                    runtime.ai_messages[index].pending = false;
                    let message = runtime.ai_messages[index].clone();
                    append_ai_log(&runtime, &message);
                }
            }
            Err(peer::Delivery::Unreachable(_)) => unreachable.push(item.peer_instance_id.clone()),
        }
    }
}

/// Background upkeep while BridgeLink runs: the relay outbox, and the workspace every minute.
fn spawn_upkeep(manager: BridgeLinkManager, shutdown: Arc<AtomicBool>) {
    thread::spawn(move || {
        let mut rounds = 0u32;
        while !shutdown.load(Ordering::Relaxed) {
            for _ in 0..15 {
                if shutdown.load(Ordering::Relaxed) {
                    return;
                }
                thread::sleep(Duration::from_secs(1));
            }
            let has_outbox = manager.lock().map(|r| !r.outbox.is_empty()).unwrap_or(false);
            if has_outbox {
                flush_outbox(&manager);
            }
            rounds += 1;
            if rounds % 4 == 1 {
                workspace::push(&manager);
            }
            if rounds % 2 == 1 {
                notes::pull_all(&manager);
                calendar::pull_all(&manager);
            }
        }
    });
}

#[tauri::command]
pub fn bridgelink_start(
    app: AppHandle,
    display_name: String,
    api_port: u16,
    localsend_port: u16,
    syncthing_id: String,
    manager: State<'_, BridgeLinkManager>,
) -> Result<BridgeLinkStatus, String> {
    start(&app, &manager, display_name, api_port, localsend_port, syncthing_id)
}

/// Starts discovery, the encrypted peer endpoint and the loopback API, or updates the advertised
/// metadata when already running. Called at process start (see `lib.rs` setup) and again by the UI.
pub fn start(
    app: &AppHandle,
    manager: &BridgeLinkManager,
    display_name: String,
    api_port: u16,
    localsend_port: u16,
    syncthing_id: String,
) -> Result<BridgeLinkStatus, String> {
    let port = if api_port == 0 { DEFAULT_API_PORT } else { api_port };
    let name = if display_name.trim().is_empty() { local_name() } else { display_name.trim().to_string() };
    let restarting = {
        let mut runtime = manager.lock()?;
        if runtime.running && runtime.api_port == port {
            // Already listening: only refresh what is advertised. Never stop/start here; the UI calls
            // this after load, and a stop followed by a delayed start left the API down for minutes.
            runtime.display_name = name;
            runtime.localsend_port = if localsend_port == 0 { 53317 } else { localsend_port };
            if !syncthing_id.trim().is_empty() { runtime.syncthing_device_id = Some(syncthing_id.trim().to_string()); }
            return Ok(snapshot(&mut runtime));
        }
        if runtime.running {
            // API port changed in settings: shut everything down and rebind below.
            runtime.shutdown.store(true, Ordering::Relaxed);
            if let Some(link) = runtime.link.take() {
                link.close();
            }
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

    let dir = storage_dir(app)?;
    let instance_id = load_or_create_instance_id(&dir)?;
    let identity = Identity::load_or_create(&dir)?;
    let peers = load_peers(&dir);
    let legacy = load_legacy(&dir, &peers);
    let outbox = load_json::<Vec<OutboxItem>>(&dir.join("outbox.json")).unwrap_or_default();
    let ai_token = load_or_create_ai_token(&dir)?;
    let ai_messages = load_ai_messages(&dir);
    let ai_workspace = workspace::Workspace::load(&dir);
    let note_store = notes::NoteStore::load(&dir);
    let calendar_store = calendar::CalendarStore::load(&dir);
    let listener = local::bind(port)?;
    let udp = discovery::bind()?;
    let link = Link::bind(port, identity.clone(), Arc::new(peer::PeerHandler { manager: manager.clone() }))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    {
        let mut runtime = manager.lock()?;
        runtime.running = true;
        runtime.instance_id = instance_id;
        runtime.display_name = name;
        runtime.platform = platform_key().to_string();
        runtime.api_port = port;
        runtime.localsend_port = if localsend_port == 0 { 53317 } else { localsend_port };
        runtime.syncthing_device_id = (!syncthing_id.trim().is_empty()).then(|| syncthing_id.trim().to_string());
        runtime.storage_dir = Some(dir);
        runtime.paired = peers;
        runtime.legacy = legacy;
        runtime.outbox = outbox;
        runtime.ai_token = ai_token;
        runtime.app = Some(app.clone());
        runtime.ai_messages = ai_messages;
        runtime.workspace = ai_workspace;
        runtime.notes = note_store;
        runtime.calendar = calendar_store;
        runtime.fingerprint = identity.fingerprint.clone();
        runtime.link = Some(link);
        runtime.shutdown = shutdown.clone();
        runtime.detail = Some(if runtime.legacy.is_empty() {
            format!("Discovering devices on UDP {}; encrypted link on UDP {port}", discovery::DISCOVERY_PORT)
        } else {
            "Devices paired with BridgeDeck 0.8 or older must be paired again (Computers tab)".to_string()
        });
    }

    local::spawn(listener, manager.clone(), shutdown.clone());
    discovery::spawn(udp, manager.clone(), shutdown.clone());
    discovery::spawn_tailscale(manager.clone(), shutdown.clone());
    spawn_upkeep(manager.clone(), shutdown);

    let mut runtime = manager.lock()?;
    Ok(snapshot(&mut runtime))
}

#[tauri::command]
pub fn bridgelink_stop(manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkStatus, String> {
    let mut runtime = manager.lock()?;
    runtime.shutdown.store(true, Ordering::Relaxed);
    if let Some(link) = runtime.link.take() {
        link.close();
    }
    runtime.running = false;
    runtime.detail = Some("Automatic pairing stopped".into());
    Ok(snapshot(&mut runtime))
}

#[tauri::command]
pub fn bridgelink_status(manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkStatus, String> {
    let mut runtime = manager.lock()?;
    Ok(snapshot(&mut runtime))
}

#[tauri::command]
pub fn bridgelink_forget(instance_id: String, manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkStatus, String> {
    let mut runtime = manager.lock()?;
    runtime.paired.remove(&instance_id);
    runtime.outbox.retain(|item| item.peer_instance_id != instance_id);
    save_outbox(&runtime);
    save_peers(&runtime)?;
    if runtime.legacy.remove(&instance_id).is_some() {
        save_legacy(&runtime);
    }
    runtime.detail = Some("Paired computer removed".into());
    Ok(snapshot(&mut runtime))
}

#[tauri::command]
pub fn bridgelink_ai_messages(since: u64, manager: State<'_, BridgeLinkManager>) -> Result<Vec<AiMessage>, String> {
    let runtime = manager.lock()?;
    Ok(ai_messages_since(&runtime, since, &AiFilter::default()))
}

#[tauri::command]
pub async fn bridgelink_ai_send(
    author: String,
    body: String,
    channel: Option<String>,
    to: Option<Vec<String>>,
    room: Option<String>,
    manager: State<'_, BridgeLinkManager>,
) -> Result<AiMessage, String> {
    let manager = manager.inner().clone();
    let send = AiSendWire { author, body, channel, reply_to: None, peer_instance_id: None, to: to.unwrap_or_default(), room };
    tauri::async_runtime::spawn_blocking(move || ai_send_internal(&manager, send))
        .await
        .map_err(|e| e.to_string())?
}

/// Path of the local AI token file, shown in the UI so AI CLIs can be pointed at it.
#[tauri::command]
pub fn bridgelink_ai_token_path(manager: State<'_, BridgeLinkManager>) -> Result<String, String> {
    let runtime = manager.lock()?;
    let dir = runtime.storage_dir.as_ref().ok_or("BridgeLink is not started")?;
    Ok(dir.join("ai-token").to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailscale_addresses_are_recognised() {
        assert!(is_tailscale_host("100.101.102.103"));
        assert!(is_tailscale_host("100.64.0.1"));
        assert!(!is_tailscale_host("100.128.0.1"));
        assert!(!is_tailscale_host("192.168.4.28"));
        assert!(!is_tailscale_host("mac.tailnet.ts.net"));
    }

    #[test]
    fn delivered_messages_replace_their_queued_copy_in_the_log() {
        let dir = std::env::temp_dir().join(format!("bd-log-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let queued = AiMessage {
            id: "m1".into(), channel: "c".into(), author: "a".into(), body: "hi".into(), reply_to: None,
            direction: "out".into(), peer_instance_id: "p".into(), peer_name: "Mac".into(), created_at: 1, pending: true,
            to: vec![], room: None,
        };
        let delivered = AiMessage { pending: false, ..queued.clone() };
        let other = AiMessage { id: "m2".into(), ..delivered.clone() };
        let lines: Vec<String> = [&queued, &other, &delivered].iter().map(|m| serde_json::to_string(m).unwrap()).collect();
        fs::write(dir.join("ai-messages.jsonl"), lines.join("\n") + "\n").unwrap();
        let loaded = load_ai_messages(&dir);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "m1");
        assert!(!loaded[0].pending);
        // Compacted on load: one line per message.
        assert_eq!(fs::read_to_string(dir.join("ai-messages.jsonl")).unwrap().lines().count(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn peer_addresses_prefer_current_then_lan_then_tailscale() {
        let mut runtime = Runtime::default();
        let peer = PersistedPeer {
            instance_id: "p".into(), name: "Mac".into(), platform: "macos".into(), host: "192.168.4.28".into(), api_port: 41416,
            fingerprint: "f".into(), localsend_port: 53317, syncthing_device_id: None, paired_at: 0, mac_addresses: Vec::new(),
        };
        runtime.seen.insert("p".into(), vec![("100.100.1.2".into(), 5, true), ("192.168.4.28".into(), 9, false), ("192.168.1.50".into(), 3, false)]);
        let addresses: Vec<String> = peer_addresses(&runtime, &peer).iter().map(|a| a.ip().to_string()).collect();
        assert_eq!(addresses, vec!["192.168.4.28", "192.168.1.50", "100.100.1.2"]);
    }
}
