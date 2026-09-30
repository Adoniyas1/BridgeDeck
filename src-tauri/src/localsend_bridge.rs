use bytes::Bytes;
use futures_util::StreamExt;
use localsend::discovery::{DeviceChannel, DiscoveryConfig, DiscoveryEvent};
use localsend::http::client::v2::LsHttpClientV2;
use localsend::http::dto_v2::{PrepareUploadRequestDtoV2, RegisterDtoV2};
use localsend::http::server::common::save::FileUploadTarget;
use localsend::http::server::v2::{PrepareUploadDecisionV2, ServerEventV2, SessionEndReasonV2};
use localsend::http::server::{start_with_port, ServerConfigV2, TlsConfig};
use localsend::http::state::ClientInfo;
use localsend::model::discovery::{DeviceType, ProtocolType, PROTOCOL_VERSION_V2};
use localsend::model::transfer::{FileContent, FileDto, FileMetadata};
use localsend::multicast::{MulticastDevice, DEFAULT_MULTICAST_GROUP, DEFAULT_MULTICAST_GROUP_V6, DEFAULT_PORT};
use localsend::util::interface::InterfaceFilter;
use localsend::reqwest;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use walkdir::WalkDir;

const RECENT_LIMIT: usize = 30;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSendDevice {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub protocol: String,
    pub fingerprint: String,
    pub device_model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSendIncomingFile {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub file_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSendPending {
    pub session_id: String,
    pub sender_alias: String,
    pub host: String,
    pub files: Vec<LocalSendIncomingFile>,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSendActive {
    pub session_id: String,
    pub sender_alias: String,
    pub files_total: usize,
    pub files_done: usize,
    pub total_bytes: u64,
    pub received_bytes: u64,
    pub started_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSendRecent {
    pub session_id: String,
    pub sender_alias: String,
    pub files: usize,
    pub bytes: u64,
    pub status: String,
    pub destination: String,
    pub finished_at: u64,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSendReceiverStatus {
    pub running: bool,
    pub alias: String,
    pub port: u16,
    pub destination: String,
    pub fingerprint: Option<String>,
    pub pending: Option<LocalSendPending>,
    pub active: Option<LocalSendActive>,
    pub recent: Vec<LocalSendRecent>,
    pub devices: Vec<LocalSendDevice>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSendTransferResult {
    pub ok: bool,
    pub target: String,
    pub paths: Vec<String>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedIdentity {
    cert_pem: String,
    key_pem: String,
    fingerprint: String,
}

#[derive(Clone)]
struct BridgeIdentity {
    alias: String,
    port: u16,
    persisted: PersistedIdentity,
}

impl BridgeIdentity {
    fn tls_config(&self) -> TlsConfig {
        TlsConfig {
            cert: self.persisted.cert_pem.clone(),
            private_key: self.persisted.key_pem.clone(),
        }
    }

    fn client_info(&self) -> ClientInfo {
        ClientInfo {
            alias: self.alias.clone(),
            version: PROTOCOL_VERSION_V2.to_string(),
            device_model: Some("BridgeDeck".to_string()),
            device_type: Some(DeviceType::Desktop),
            token: self.persisted.fingerprint.clone(),
        }
    }

    fn register_dto(&self) -> RegisterDtoV2 {
        RegisterDtoV2 {
            alias: self.alias.clone(),
            version: PROTOCOL_VERSION_V2.to_string(),
            device_model: Some("BridgeDeck".to_string()),
            device_type: Some(DeviceType::Desktop),
            fingerprint: self.persisted.fingerprint.clone(),
            port: self.port,
            protocol: ProtocolType::Https,
            download: false,
        }
    }

    fn multicast_device(&self) -> MulticastDevice {
        MulticastDevice {
            alias: self.alias.clone(),
            version: PROTOCOL_VERSION_V2.to_string(),
            device_model: Some("BridgeDeck".to_string()),
            device_type: Some(DeviceType::Desktop),
            fingerprint: self.persisted.fingerprint.clone(),
            port: self.port,
            protocol: ProtocolType::Https,
            download: false,
        }
    }
}

struct PendingInternal {
    summary: LocalSendPending,
    files: HashMap<String, FileDto>,
    decision_tx: oneshot::Sender<PrepareUploadDecisionV2>,
}

struct ActiveInternal {
    summary: LocalSendActive,
    finalized_bytes: u64,
    failed_files: usize,
    progress: HashMap<String, u64>,
    destination: PathBuf,
    end_status: Option<String>,
}

struct LocalSendRuntime {
    running: bool,
    alias: String,
    port: u16,
    destination: PathBuf,
    fingerprint: Option<String>,
    auto_accept: bool,
    /// Paired BridgeLink computers; their transfers skip the approval prompt.
    trusted_hosts: HashSet<String>,
    pending: Option<PendingInternal>,
    active: Option<ActiveInternal>,
    recent: VecDeque<LocalSendRecent>,
    devices: Vec<LocalSendDevice>,
    server_stop: Option<oneshot::Sender<()>>,
    discovery_stop: Option<oneshot::Sender<()>>,
    detail: Option<String>,
}

impl Default for LocalSendRuntime {
    fn default() -> Self {
        Self {
            running: false,
            alias: "BridgeDeck".to_string(),
            port: DEFAULT_PORT,
            destination: PathBuf::new(),
            fingerprint: None,
            auto_accept: false,
            trusted_hosts: HashSet::new(),
            pending: None,
            active: None,
            recent: VecDeque::new(),
            devices: Vec::new(),
            server_stop: None,
            discovery_stop: None,
            detail: Some("Receiver is stopped".to_string()),
        }
    }
}

#[derive(Clone, Default)]
pub struct LocalSendManager {
    inner: Arc<Mutex<LocalSendRuntime>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("localsend");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("identity.json"))
}

fn load_or_create_identity(app: &AppHandle, alias: &str, port: u16) -> Result<BridgeIdentity, String> {
    let path = identity_path(app)?;
    let persisted = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<PersistedIdentity>(&raw).map_err(|e| format!("Invalid LocalSend identity: {e}"))?
    } else {
        let generated = localsend::crypto::cert::generate_self_signed().map_err(|e| e.to_string())?;
        let persisted = PersistedIdentity {
            cert_pem: generated.certificate_pem,
            key_pem: generated.private_key_pem,
            fingerprint: generated.fingerprint,
        };
        let raw = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
        fs::write(&path, raw).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        }
        persisted
    };
    Ok(BridgeIdentity { alias: alias.to_string(), port, persisted })
}

/// Folder incoming transfers are saved to: the receiver's configured folder, else the default.
/// Used to find a source bundle the paired computer sent for an upgrade.
pub fn receive_destination(app: &AppHandle) -> PathBuf {
    let configured = app.state::<LocalSendManager>().inner.lock().ok().map(|r| r.destination.clone()).filter(|p| !p.as_os_str().is_empty());
    configured.unwrap_or_else(|| default_destination(app))
}

fn default_destination(app: &AppHandle) -> PathBuf {
    app.path().download_dir().unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn snapshot(runtime: &LocalSendRuntime) -> LocalSendReceiverStatus {
    LocalSendReceiverStatus {
        running: runtime.running,
        alias: runtime.alias.clone(),
        port: runtime.port,
        destination: runtime.destination.to_string_lossy().to_string(),
        fingerprint: runtime.fingerprint.clone(),
        pending: runtime.pending.as_ref().map(|p| p.summary.clone()),
        active: runtime.active.as_ref().map(|a| {
            let mut summary = a.summary.clone();
            summary.received_bytes = a.finalized_bytes + a.progress.values().copied().sum::<u64>();
            summary
        }),
        recent: runtime.recent.iter().cloned().collect(),
        devices: runtime.devices.clone(),
        detail: runtime.detail.clone(),
    }
}

fn remember_device(runtime: &mut LocalSendRuntime, device: LocalSendDevice) {
    if let Some(existing) = runtime.devices.iter_mut().find(|d| d.fingerprint == device.fingerprint || (d.host == device.host && d.port == device.port)) {
        *existing = device;
    } else {
        runtime.devices.push(device);
        runtime.devices.sort_by(|a, b| a.alias.to_lowercase().cmp(&b.alias.to_lowercase()));
    }
}

fn device_from_discovery(device: localsend::discovery::DiscoveredDevice) -> Option<LocalSendDevice> {
    match device.channel {
        DeviceChannel::Http(http) => Some(LocalSendDevice {
            alias: device.alias,
            host: http.host,
            port: http.port,
            protocol: http.protocol.as_str().to_string(),
            fingerprint: device.fingerprint,
            device_model: device.device_model,
        }),
        _ => None,
    }
}

fn incoming_files(files: &HashMap<String, FileDto>) -> Vec<LocalSendIncomingFile> {
    let mut out = files.iter().map(|(id, file)| LocalSendIncomingFile {
        id: id.clone(),
        name: file.file_name.clone(),
        size: file.size,
        file_type: file.file_type.clone(),
    }).collect::<Vec<_>>();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn incoming_text(files: &HashMap<String, FileDto>) -> Option<String> {
    if files.len() != 1 { return None; }
    let file = files.values().next()?;
    if file.file_type == "text" || file.file_type.starts_with("text/") {
        return file.preview.clone();
    }
    None
}

fn safe_relative(name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return Err("Incoming path contains unsafe components".into()),
        }
    }
    if clean.as_os_str().is_empty() { return Err("Incoming file has an empty name".into()); }
    Ok(clean)
}

fn unique_target(destination: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = safe_relative(name)?;
    let candidate = destination.join(&relative);
    if !candidate.exists() {
        if let Some(parent) = candidate.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        return Ok(candidate);
    }
    let parent = candidate.parent().unwrap_or(destination);
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let stem = candidate.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = candidate.extension().and_then(|s| s.to_str());
    for index in 1..10_000u32 {
        let file_name = match ext {
            Some(ext) => format!("{stem} ({index}).{ext}"),
            None => format!("{stem} ({index})"),
        };
        let next = parent.join(file_name);
        if !next.exists() { return Ok(next); }
    }
    Err("Could not allocate a unique destination filename".into())
}

fn push_recent(runtime: &mut LocalSendRuntime, record: LocalSendRecent) {
    runtime.recent.push_front(record);
    while runtime.recent.len() > RECENT_LIMIT { runtime.recent.pop_back(); }
}

fn finish_active_if_ready(runtime: &mut LocalSendRuntime) {
    let ready = runtime
        .active
        .as_ref()
        .is_some_and(|active| active.end_status.is_some() && active.progress.is_empty());
    if !ready { return; }

    let active = runtime.active.take().expect("active transfer disappeared");
    let mut status = active.end_status.unwrap_or_else(|| "received".to_string());
    if status == "received" && active.failed_files > 0 { status = "partial".to_string(); }
    push_recent(runtime, LocalSendRecent {
        session_id: active.summary.session_id,
        sender_alias: active.summary.sender_alias,
        files: active.summary.files_done,
        bytes: active.finalized_bytes,
        status,
        destination: active.destination.to_string_lossy().to_string(),
        finished_at: now_ms(),
        message: None,
    });
    runtime.detail = Some("Receiver running and ready".into());
}

fn accept_pending_locked(runtime: &mut LocalSendRuntime, session_id: &str) -> Result<(), String> {
    let Some(pending) = runtime.pending.take() else { return Err("No pending LocalSend request".into()); };
    if pending.summary.session_id != session_id {
        runtime.pending = Some(pending);
        return Err("Pending LocalSend session changed; refresh and try again".into());
    }
    let ids: HashSet<String> = pending.files.keys().cloned().collect();
    pending.decision_tx.send(PrepareUploadDecisionV2::Accept(ids)).map_err(|_| "Sender stopped waiting for a decision".to_string())?;
    runtime.active = Some(ActiveInternal {
        summary: LocalSendActive {
            session_id: pending.summary.session_id,
            sender_alias: pending.summary.sender_alias,
            files_total: pending.files.len(),
            files_done: 0,
            total_bytes: pending.summary.total_bytes,
            received_bytes: 0,
            started_at: now_ms(),
        },
        finalized_bytes: 0,
        failed_files: 0,
        progress: HashMap::new(),
        destination: runtime.destination.clone(),
        end_status: None,
    });
    runtime.detail = Some("Receiving transfer".into());
    Ok(())
}

#[tauri::command]
pub fn localsend_set_trusted_hosts(hosts: Vec<String>, manager: State<'_, LocalSendManager>) -> Result<(), String> {
    let mut runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
    runtime.trusted_hosts = hosts
        .iter()
        .filter_map(|h| h.trim().trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().ok())
        .map(|ip| ip.to_canonical().to_string())
        .collect();
    Ok(())
}

#[tauri::command]
pub fn localsend_receiver_status(manager: State<'_, LocalSendManager>) -> Result<LocalSendReceiverStatus, String> {
    let runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
    Ok(snapshot(&runtime))
}

#[tauri::command]
pub async fn localsend_receiver_start(
    app: AppHandle,
    manager: State<'_, LocalSendManager>,
    alias: String,
    destination: String,
    port: u16,
    pin: String,
    auto_accept: bool,
) -> Result<LocalSendReceiverStatus, String> {
    {
        let runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
        if runtime.running { return Ok(snapshot(&runtime)); }
    }

    let alias = if alias.trim().is_empty() { "BridgeDeck".to_string() } else { alias.trim().to_string() };
    let requested_port = if port == 0 { DEFAULT_PORT } else { port };
    let destination = if destination.trim().is_empty() { default_destination(&app) } else { PathBuf::from(destination.trim()) };
    fs::create_dir_all(&destination).map_err(|e| format!("Could not create receive folder: {e}"))?;

    let mut identity = load_or_create_identity(&app, &alias, requested_port)?;
    let (server_tx, mut server_rx) = mpsc::channel::<ServerEventV2>(32);
    let (server_stop_tx, server_stop_rx) = oneshot::channel::<()>();
    let server = start_with_port(
        requested_port,
        Some(identity.tls_config()),
        identity.client_info(),
        None,
        Some(ServerConfigV2 {
            pin: (!pin.trim().is_empty()).then(|| pin.trim().to_string()),
            verify_checksums: true,
            event_tx: server_tx,
        }),
        None,
        server_stop_rx,
    ).await.map_err(|e| format!("Could not start LocalSend server: {e:#}"))?;
    identity.port = server.port();
    let server = Arc::new(server);

    let (discovery_tx, mut discovery_rx) = mpsc::channel::<DiscoveryEvent>(64);
    let (discovery_stop_tx, discovery_stop_rx) = oneshot::channel::<()>();
    let discovery = Arc::new(localsend::discovery::start(
        DiscoveryConfig {
            group: DEFAULT_MULTICAST_GROUP,
            group_v6: Some(DEFAULT_MULTICAST_GROUP_V6),
            port: DEFAULT_PORT,
            interface_filter: InterfaceFilter::default(),
            device: identity.multicast_device(),
            identity: localsend::discovery::DeviceIdentity {
                cert_pem: identity.persisted.cert_pem.clone(),
                private_key_pem: identity.persisted.key_pem.clone(),
            },
            timeout: Duration::from_millis(600),
            event_tx: Some(discovery_tx),
        },
        discovery_stop_rx,
    ).await);

    {
        let mut runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
        runtime.running = true;
        runtime.alias = alias.clone();
        runtime.port = identity.port;
        runtime.destination = destination.clone();
        runtime.fingerprint = Some(identity.persisted.fingerprint.clone());
        runtime.auto_accept = auto_accept;
        runtime.pending = None;
        runtime.active = None;
        runtime.server_stop = Some(server_stop_tx);
        runtime.discovery_stop = Some(discovery_stop_tx);
        runtime.detail = discovery.multicast_error().map(|e| format!("Receiver running; multicast unavailable: {e:#}")).or_else(|| Some("Receiver running and discoverable on the LAN".into()));
    }

    let announce = discovery.clone();
    tauri::async_runtime::spawn(async move { announce.announce().await; });

    let state = manager.inner.clone();
    let discovery_for_register = discovery.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                event = server_rx.recv() => {
                    let Some(event) = event else { break; };
                    match event {
                        ServerEventV2::Register { ip, info } => {
                            let discovered = localsend::discovery::DiscoveredDevice {
                                alias: info.alias.clone(),
                                version: info.version.clone(),
                                device_model: info.device_model.clone(),
                                device_type: info.device_type.clone(),
                                fingerprint: info.fingerprint.clone(),
                                channel: DeviceChannel::Http(localsend::discovery::HttpChannel {
                                    host: ip.to_string(),
                                    port: info.port,
                                    protocol: info.protocol,
                                }),
                                download: info.download,
                            };
                            let _ = discovery_for_register.add_device(discovered.clone()).await;
                            if let Some(device) = device_from_discovery(discovered) {
                                if let Ok(mut runtime) = state.lock() { remember_device(&mut runtime, device); }
                            }
                        }
                        ServerEventV2::PrepareUpload { session_id, ip, info, files, decision_tx, .. } => {
                            if let Some(message) = incoming_text(&files) {
                                let _ = decision_tx.send(PrepareUploadDecisionV2::Accept(HashSet::new()));
                                if let Ok(mut runtime) = state.lock() {
                                    let destination = runtime.destination.to_string_lossy().to_string();
                                    push_recent(&mut runtime, LocalSendRecent {
                                        session_id,
                                        sender_alias: info.alias,
                                        files: 0,
                                        bytes: 0,
                                        status: "message".into(),
                                        destination,
                                        finished_at: now_ms(),
                                        message: Some(message),
                                    });
                                }
                                continue;
                            }
                            let list = incoming_files(&files);
                            let total_bytes = list.iter().map(|f| f.size).sum();
                            let summary = LocalSendPending { session_id: session_id.clone(), sender_alias: info.alias, host: ip.to_string(), files: list, total_bytes };
                            if let Ok(mut runtime) = state.lock() {
                                let trusted = runtime.trusted_hosts.contains(&ip.ip.to_canonical().to_string());
                                runtime.pending = Some(PendingInternal { summary, files, decision_tx });
                                runtime.detail = Some(if trusted { "Receiving from paired computer".into() } else { "Incoming transfer waiting for approval".into() });
                                if runtime.auto_accept || trusted {
                                    let _ = accept_pending_locked(&mut runtime, &session_id);
                                }
                            }
                        }
                        ServerEventV2::FileUpload { session_id, file_id, file, target_tx } => {
                            let (target, progress_tx, result_tx, result_rx) = {
                                let mut runtime = match state.lock() { Ok(r) => r, Err(_) => continue };
                                let Some(active) = runtime.active.as_mut().filter(|a| a.summary.session_id == session_id) else { continue; };
                                let target = match unique_target(&active.destination, &file.file_name) {
                                    Ok(path) => path,
                                    Err(_) => continue,
                                };
                                active.progress.insert(file_id.clone(), 0);
                                let (progress_tx, mut progress_rx) = mpsc::channel::<u64>(16);
                                let (result_tx, result_rx) = oneshot::channel::<Result<(), String>>();
                                let progress_state = state.clone();
                                let progress_file = file_id.clone();
                                tauri::async_runtime::spawn(async move {
                                    while let Some(value) = progress_rx.recv().await {
                                        if let Ok(mut runtime) = progress_state.lock() {
                                            if let Some(active) = runtime.active.as_mut() { active.progress.insert(progress_file.clone(), value); }
                                        }
                                    }
                                });
                                (target, progress_tx, result_tx, result_rx)
                            };
                            let _ = target_tx.send(FileUploadTarget::Path { path: target, result_tx, progress_tx: Some(progress_tx) });
                            let result_state = state.clone();
                            tauri::async_runtime::spawn(async move {
                                let result = result_rx.await.unwrap_or_else(|_| Err("Upload aborted".into()));
                                if let Ok(mut runtime) = result_state.lock() {
                                    if let Some(active) = runtime.active.as_mut().filter(|a| a.summary.session_id == session_id) {
                                        let done = active.progress.remove(&file_id).unwrap_or(0);
                                        if result.is_ok() {
                                            active.finalized_bytes = active.finalized_bytes.saturating_add(file.size.max(done));
                                            active.summary.files_done += 1;
                                        } else {
                                            active.failed_files += 1;
                                        }
                                    }
                                    finish_active_if_ready(&mut runtime);
                                }
                            });
                        }
                        ServerEventV2::SessionEnd { session_id, reason } => {
                            if let Ok(mut runtime) = state.lock() {
                                if let Some(active) = runtime.active.as_mut().filter(|a| a.summary.session_id == session_id) {
                                    active.end_status = Some(match reason {
                                        SessionEndReasonV2::Finished => "received".to_string(),
                                        SessionEndReasonV2::Cancelled => "cancelled".to_string(),
                                    });
                                }
                                finish_active_if_ready(&mut runtime);
                            }
                        }
                        ServerEventV2::PrepareUploadAborted { session_id } => {
                            if let Ok(mut runtime) = state.lock() {
                                if runtime.pending.as_ref().is_some_and(|p| p.summary.session_id == session_id) {
                                    runtime.pending = None;
                                    runtime.detail = Some("Incoming request was cancelled by sender".into());
                                }
                            }
                        }
                        ServerEventV2::ListenerFailed { error } => {
                            if let Ok(mut runtime) = state.lock() {
                                runtime.running = false;
                                runtime.detail = Some(format!("Receiver stopped: {error}"));
                            }
                            break;
                        }
                        ServerEventV2::CancelReceived { .. } => {}
                    }
                }
                event = discovery_rx.recv() => {
                    let Some(event) = event else { break; };
                    match event {
                        DiscoveryEvent::Discovered { device } | DiscoveryEvent::Updated { device } => {
                            if let Some(device) = device_from_discovery(device) {
                                if let Ok(mut runtime) = state.lock() { remember_device(&mut runtime, device); }
                            }
                        }
                        DiscoveryEvent::MulticastFailed => {
                            if let Ok(mut runtime) = state.lock() { runtime.detail = Some("Receiver running; multicast discovery stopped".into()); }
                        }
                    }
                }
            }
        }
        let _ = server.wait_stopped().await;
        discovery.wait_stopped().await;
    });

    let runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
    Ok(snapshot(&runtime))
}

#[tauri::command]
pub async fn localsend_receiver_stop(manager: State<'_, LocalSendManager>) -> Result<LocalSendReceiverStatus, String> {
    let (server_stop, discovery_stop) = {
        let mut runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
        let server_stop = runtime.server_stop.take();
        let discovery_stop = runtime.discovery_stop.take();
        runtime.running = false;
        runtime.pending = None;
        runtime.active = None;
        runtime.detail = Some("Receiver stopped".into());
        (server_stop, discovery_stop)
    };
    if let Some(stop) = server_stop { let _ = stop.send(()); }
    if let Some(stop) = discovery_stop { let _ = stop.send(()); }
    let runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
    Ok(snapshot(&runtime))
}

#[tauri::command]
pub fn localsend_accept(session_id: String, manager: State<'_, LocalSendManager>) -> Result<LocalSendReceiverStatus, String> {
    let mut runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
    accept_pending_locked(&mut runtime, &session_id)?;
    Ok(snapshot(&runtime))
}

#[tauri::command]
pub fn localsend_decline(session_id: String, manager: State<'_, LocalSendManager>) -> Result<LocalSendReceiverStatus, String> {
    let mut runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
    let Some(pending) = runtime.pending.take() else { return Err("No pending LocalSend request".into()); };
    if pending.summary.session_id != session_id {
        runtime.pending = Some(pending);
        return Err("Pending LocalSend session changed; refresh and try again".into());
    }
    pending.decision_tx.send(PrepareUploadDecisionV2::Decline).map_err(|_| "Sender stopped waiting for a decision".to_string())?;
    runtime.detail = Some("Incoming transfer declined".into());
    Ok(snapshot(&runtime))
}

fn target_from_runtime(runtime: &LocalSendRuntime, target: &str) -> (String, u16, ProtocolType, Option<String>, String) {
    if let Some(device) = runtime.devices.iter().find(|d| d.alias.eq_ignore_ascii_case(target.trim())) {
        let protocol = if device.protocol.eq_ignore_ascii_case("http") { ProtocolType::Http } else { ProtocolType::Https };
        return (device.host.clone(), device.port, protocol, Some(device.fingerprint.clone()), device.alias.clone());
    }
    let target = target.trim();
    if let Some((host, port)) = target.rsplit_once(':') {
        if !host.contains(':') {
            if let Ok(port) = port.parse::<u16>() { return (host.to_string(), port, ProtocolType::Https, None, target.to_string()); }
        }
    }
    (target.to_string(), DEFAULT_PORT, ProtocolType::Https, None, target.to_string())
}

fn collect_paths(paths: &[String]) -> Result<(HashMap<String, FileDto>, HashMap<String, PathBuf>, u64), String> {
    let mut files = HashMap::new();
    let mut actual = HashMap::new();
    let mut total = 0u64;
    for raw in paths {
        let root = PathBuf::from(raw);
        let meta = fs::symlink_metadata(&root).map_err(|e| format!("Cannot read {raw}: {e}"))?;
        if meta.file_type().is_symlink() { return Err(format!("Symlink transfer roots are not allowed: {raw}")); }
        let entries: Vec<(PathBuf, String)> = if meta.is_dir() {
            let root_name = root.file_name().and_then(|s| s.to_str()).unwrap_or("folder").to_string();
            WalkDir::new(&root).follow_links(false).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()).map(|entry| {
                let relative = entry.path().strip_prefix(&root).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
                (entry.path().to_path_buf(), format!("{root_name}/{relative}"))
            }).collect()
        } else if meta.is_file() {
            vec![(root.clone(), root.file_name().and_then(|s| s.to_str()).unwrap_or("file").to_string())]
        } else { Vec::new() };

        for (path, transfer_name) in entries {
            let metadata = fs::metadata(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
            let id = Uuid::new_v4().to_string();
            total = total.saturating_add(metadata.len());
            files.insert(id.clone(), FileDto {
                id: id.clone(),
                file_name: transfer_name,
                size: metadata.len(),
                file_type: mime_guess::from_path(&path).first_or_octet_stream().to_string(),
                sha256: None,
                preview: None,
                metadata: FileMetadata::from_fs_metadata(&metadata),
            });
            actual.insert(id, path);
        }
    }
    if files.is_empty() { return Err("No readable files were selected".into()); }
    Ok((files, actual, total))
}

fn upload_body(content: FileContent) -> reqwest::Body {
    let stream = ReceiverStream::new(content.into_receiver()).map(|chunk| Ok::<Bytes, anyhow::Error>(chunk));
    reqwest::Body::wrap_stream(stream)
}

#[tauri::command]
pub async fn localsend_send_native(
    app: AppHandle,
    manager: State<'_, LocalSendManager>,
    target: String,
    paths: Vec<String>,
    pin: String,
) -> Result<LocalSendTransferResult, String> {
    if target.trim().is_empty() { return Err("LocalSend target alias or IP is required".into()); }
    if paths.is_empty() { return Err("Choose at least one file or folder".into()); }
    let (host, port, protocol, remembered_fingerprint, label, alias, own_port) = {
        let runtime = manager.inner.lock().map_err(|_| "LocalSend state lock poisoned")?;
        let (host, port, protocol, fingerprint, label) = target_from_runtime(&runtime, &target);
        (host, port, protocol, fingerprint, label, runtime.alias.clone(), runtime.port)
    };
    let identity = load_or_create_identity(&app, &alias, own_port)?;
    let (files, actual_paths, total_bytes) = collect_paths(&paths)?;

    let unpinned = LsHttpClientV2::try_new(&identity.persisted.key_pem, &identity.persisted.cert_pem, remembered_fingerprint.clone(), Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let registration = unpinned.register(protocol, &host, port, identity.register_dto()).await.map_err(|e| format!("Could not reach {label}: {e}"))?;
    let fingerprint = match protocol {
        ProtocolType::Https => registration.cert_fingerprint.or(remembered_fingerprint).or(Some(registration.body.fingerprint.clone())),
        ProtocolType::Http => None,
    };
    let client = LsHttpClientV2::try_new(&identity.persisted.key_pem, &identity.persisted.cert_pem, fingerprint, None).map_err(|e| e.to_string())?;
    let cancel = CancellationToken::new();
    let prepared = client.prepare_upload(
        protocol,
        &host,
        port,
        None,
        PrepareUploadRequestDtoV2 { info: identity.register_dto(), files: files.clone() },
        (!pin.trim().is_empty()).then_some(pin.trim()),
        cancel.clone(),
    ).await.map_err(|e| format!("{label}: prepare upload failed: {e}"))?;
    let Some(response) = prepared.response else {
        return Ok(LocalSendTransferResult { ok: true, target: label, paths, stdout: "Receiver accepted no file payloads".into(), stderr: String::new(), exit_code: Some(0) });
    };

    let mut sent_files = 0usize;
    let mut sent_bytes = 0u64;
    let mut file_ids: Vec<&String> = response.files.keys().collect();
    file_ids.sort_by_key(|id| &files[*id].file_name);
    for file_id in file_ids {
        let file = &files[file_id];
        let path = actual_paths.get(file_id).ok_or("Internal transfer path missing")?.clone();
        let token = &response.files[file_id];
        if let Err(error) = client.upload(protocol, &host, port, None, &response.session_id, file_id, token, upload_body(FileContent::Path(path)), cancel.clone()).await {
            let _ = client.cancel(protocol, &host, port, &response.session_id).await;
            return Err(format!("{label}: failed to upload {}: {error}", file.file_name));
        }
        sent_files += 1;
        sent_bytes = sent_bytes.saturating_add(file.size);
    }
    Ok(LocalSendTransferResult {
        ok: true,
        target: label,
        paths,
        stdout: format!("Sent {sent_files} file(s), {sent_bytes} of {total_bytes} bytes"),
        stderr: String::new(),
        exit_code: Some(0),
    })
}
