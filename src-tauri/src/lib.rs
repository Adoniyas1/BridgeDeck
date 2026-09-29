mod localsend_bridge;
mod bridgelink;
mod syncthing_bridge;
use localsend_bridge::LocalSendManager;
use bridgelink::BridgeLinkManager;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

struct ServiceManager {
    children: Mutex<HashMap<String, Child>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedServiceState {
    service_id: String,
    running: bool,
    managed: bool,
    pid: Option<u32>,
    executable_ready: bool,
    executable: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncthingStatus {
    ok: bool,
    // camelCase would emit "myId"; the frontend (types.ts) and Syncthing both use "myID".
    #[serde(rename = "myID")]
    my_id: Option<String>,
    uptime: Option<u64>,
    alloc: Option<u64>,
    sys: Option<u64>,
    goroutines: Option<u64>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncthingFolder {
    id: String,
    label: Option<String>,
    path: Option<String>,
    paused: Option<bool>,
    r#type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MatrixMessage {
    event_id: Option<String>,
    sender: Option<String>,
    body: Option<String>,
    timestamp: Option<u64>,
    mine: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RustDeskIdentity {
    available: bool,
    id: Option<String>,
    executable: Option<String>,
    detail: Option<String>,
}


fn allowed_service(service_id: &str) -> bool {
    matches!(service_id, "rustdesk" | "syncthing" | "localsend" | "bluebubbles" | "matrix")
}

fn manageable_service(service_id: &str) -> bool {
    matches!(service_id, "rustdesk" | "syncthing" | "bluebubbles")
}

fn platform_key() -> &'static str {
    #[cfg(target_os = "windows")]
    { return "windows"; }
    #[cfg(target_os = "macos")]
    { return "macos"; }
    #[cfg(target_os = "linux")]
    { return "linux"; }
    #[allow(unreachable_code)]
    "unknown"
}

fn runtime_filename(service_id: &str) -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    {
        return match service_id {
            "rustdesk" => Some("rustdesk.exe"),
            "syncthing" => Some("syncthing.exe"),
            "localsend" => Some("localsend_app.exe"),
            "bluebubbles" => Some("BlueBubbles.exe"),
            _ => None,
        };
    }
    #[cfg(not(target_os = "windows"))]
    {
        match service_id {
            "rustdesk" => Some("rustdesk"),
            "syncthing" => Some("syncthing"),
            "localsend" => Some("localsend_app"),
            "bluebubbles" => Some("BlueBubbles"),
            _ => None,
        }
    }
}

fn bundled_runtime_path(app: &AppHandle, service_id: &str) -> Option<PathBuf> {
    let filename = runtime_filename(service_id)?;
    let rel = PathBuf::from("runtime").join(platform_key()).join(service_id).join(filename);

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join(&rel);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join(&rel);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_runtime_executable(app: &AppHandle, service_id: &str, explicit: Option<String>) -> Option<String> {
    if let Some(path) = explicit.filter(|s| !s.trim().is_empty()) {
        if Path::new(&path).exists() {
            return Some(path);
        }
    }
    bundled_runtime_path(app, service_id).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn probe_tcp(host: String, port: u16) -> bool {
    let Ok(mut addrs) = format!("{}:{}", host, port).to_socket_addrs() else { return false; };
    let Some(addr): Option<SocketAddr> = addrs.next() else { return false; };
    TcpStream::connect_timeout(&addr, Duration::from_millis(850)).is_ok()
}

#[tauri::command]
fn open_external(target: String) -> Result<(), String> {
    if !(target.starts_with("http://") || target.starts_with("https://")) {
        return Err("Only http/https URLs are allowed".into());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&target).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", &target]).status();
    #[cfg(target_os = "linux")]
    let status = Command::new("xdg-open").arg(&target).status();
    status.map_err(|e| e.to_string()).and_then(|s| if s.success() { Ok(()) } else { Err("Open command failed".into()) })
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if path.trim().is_empty() || !Path::new(&path).exists() {
        return Err("Path does not exist".into());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&path).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(&path).status();
    #[cfg(target_os = "linux")]
    let status = Command::new("xdg-open").arg(&path).status();
    status.map_err(|e| e.to_string()).and_then(|s| if s.success() { Ok(()) } else { Err("Open path failed".into()) })
}

fn app_default_name(service_id: &str) -> Option<(&'static str, &'static str)> {
    match service_id {
        "rustdesk" => Some(("RustDesk", "rustdesk.exe")),
        "localsend" => Some(("LocalSend", "localsend_app.exe")),
        "syncthing" => Some(("Syncthing", "syncthing.exe")),
        "bluebubbles" => Some(("BlueBubbles", "BlueBubbles.exe")),
        _ => None,
    }
}

#[tauri::command]
fn app_available(app: AppHandle, service_id: String, executable: Option<String>) -> bool {
    if resolve_runtime_executable(&app, &service_id, executable).is_some() {
        return true;
    }
    let Some((mac_name, win_name)) = app_default_name(&service_id) else { return false; };
    #[cfg(target_os = "macos")]
    return Command::new("open").args(["-Ra", mac_name]).status().map(|s| s.success()).unwrap_or(false);
    #[cfg(target_os = "windows")]
    return Command::new("where").arg(win_name).status().map(|s| s.success()).unwrap_or(false);
    #[cfg(target_os = "linux")]
    return Command::new("which").arg(service_id).status().map(|s| s.success()).unwrap_or(false);
}

#[tauri::command]
fn launch_app(app: AppHandle, service_id: String, executable: Option<String>) -> Result<(), String> {
    if !allowed_service(&service_id) {
        return Err("Unsupported app".into());
    }
    if let Some(path) = resolve_runtime_executable(&app, &service_id, executable) {
        return Command::new(path).spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    let Some((mac_name, win_name)) = app_default_name(&service_id) else {
        return Err("This component does not have a standalone desktop app".into());
    };
    #[cfg(target_os = "macos")]
    return Command::new("open").args(["-a", mac_name]).spawn().map(|_| ()).map_err(|e| e.to_string());
    #[cfg(target_os = "windows")]
    return Command::new(win_name).spawn().map(|_| ()).map_err(|e| e.to_string());
    #[cfg(target_os = "linux")]
    return Command::new(service_id).spawn().map(|_| ()).map_err(|e| e.to_string());
}

#[cfg(target_os = "macos")]
fn rustdesk_system_executable() -> Option<String> {
    let candidates = [
        PathBuf::from("/Applications/RustDesk.app/Contents/MacOS/RustDesk"),
        std::env::var("HOME").ok().map(|h| PathBuf::from(h).join("Applications/RustDesk.app/Contents/MacOS/RustDesk")).unwrap_or_default(),
    ];
    for candidate in candidates {
        if candidate.exists() { return Some(candidate.to_string_lossy().to_string()); }
    }
    Command::new("which").arg("rustdesk").output().ok().and_then(|o| {
        if !o.status.success() { return None; }
        let value = String::from_utf8_lossy(&o.stdout).trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

#[cfg(target_os = "windows")]
fn rustdesk_system_executable() -> Option<String> {
    // The official installer does not add RustDesk to PATH.
    let candidates = ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .map(|dir| PathBuf::from(dir).join("RustDesk").join("rustdesk.exe"))
        .chain(std::env::var("LOCALAPPDATA").ok().map(|dir| PathBuf::from(dir).join("Programs").join("RustDesk").join("rustdesk.exe")));
    for candidate in candidates {
        if candidate.exists() { return Some(candidate.to_string_lossy().to_string()); }
    }
    Command::new("where").arg("rustdesk.exe").output().ok().and_then(|o| {
        if !o.status.success() { return None; }
        let value = String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

#[cfg(target_os = "linux")]
fn rustdesk_system_executable() -> Option<String> {
    Command::new("which").arg("rustdesk").output().ok().and_then(|o| {
        if !o.status.success() { return None; }
        let value = String::from_utf8_lossy(&o.stdout).trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn resolve_rustdesk_executable(app: &AppHandle, explicit: Option<String>) -> Option<String> {
    resolve_runtime_executable(app, "rustdesk", explicit).or_else(rustdesk_system_executable)
}

/// Reports whether this project's source (kept in sync between computers by Syncthing) has files
/// newer than the running build, i.e. the other computer's edits arrived and a rebuild is due.
#[tauri::command]
fn source_update_status() -> serde_json::Value {
    let built_ms: u128 = env!("BRIDGEDECK_BUILT_MS").parse().unwrap_or(0);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let watched = ["src", "src-tauri/src", "agent", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "package.json", "index.html"];
    let mut newest: Option<(u128, String)> = None;
    if root.join("src").exists() {
        for entry in watched.iter().flat_map(|p| walkdir::WalkDir::new(root.join(p)).into_iter().filter_map(Result::ok)) {
            if !entry.file_type().is_file() { continue; }
            let Some(modified) = entry.metadata().ok().and_then(|m| m.modified().ok()) else { continue };
            let ms = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            if newest.as_ref().map_or(true, |(best, _)| ms > *best) {
                let rel = entry.path().strip_prefix(&root).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
                newest = Some((ms, rel));
            }
        }
    }
    let (newest_ms, newest_file) = newest.unwrap_or((0, String::new()));
    serde_json::json!({
        "sourceAvailable": newest_ms > 0,
        "sourceDir": root.canonicalize().unwrap_or(root).to_string_lossy(),
        "builtAt": built_ms as u64,
        "newestSourceAt": newest_ms as u64,
        "newestSourceFile": newest_file,
        // 60 s slack: files saved moments before a build finishes are part of it.
        "rebuildNeeded": newest_ms > built_ms + 60_000,
    })
}

/// Fetches `<url>/status` natively. The WebView cannot: WebView2 blocks page requests to
/// private-network addresses, which showed paired computers as "Failed to fetch".
#[tauri::command]
async fn agent_status(url: String, token: String) -> Result<serde_json::Value, String> {
    let base = checked_http_base(&url)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().map_err(|e| e.to_string())?;
    let mut request = client.get(format!("{base}/status"));
    if !token.trim().is_empty() {
        request = request.bearer_auth(token.trim());
    }
    let response = request.send().await.map_err(|e| format!("Cannot reach {base}: {}", net_err(e)))?;
    let status = response.status();
    if !status.is_success() {
        return Ok(serde_json::json!({ "ok": false, "error": format!("HTTP {status}") }));
    }
    response.json::<serde_json::Value>().await.map_err(net_err)
}

/// RustDesk's direct-IP listener (only open when "Enable direct IP access" is on at the target).
const RUSTDESK_DIRECT_PORT: u16 = 21118;

/// Starts a RustDesk session. When `host` is a LAN address whose direct-IP port answers, connects
/// by IP (stays on the LAN); otherwise falls back to the numeric ID via RustDesk's servers.
/// Returns which route was used.
#[tauri::command]
fn rustdesk_session(app: AppHandle, peer_id: String, executable: Option<String>, mode: String, host: Option<String>) -> Result<String, String> {
    let peer = peer_id.trim().replace(' ', "");
    if peer.is_empty() || !peer.chars().all(|c| c.is_ascii_digit()) {
        return Err("RustDesk peer ID must be numeric".into());
    }
    let flag = match mode.as_str() {
        "control" => "--connect",
        "file-transfer" => "--file-transfer",
        _ => return Err("Unsupported RustDesk session mode".into()),
    };
    let path = resolve_rustdesk_executable(&app, executable)
        .ok_or("RustDesk runtime not found. Install RustDesk or set its executable in Settings.")?;
    let lan_ip = host
        .as_deref()
        .and_then(|h| h.trim().trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().ok());
    let direct = lan_ip.filter(|ip| {
        let addr = std::net::SocketAddr::new(*ip, RUSTDESK_DIRECT_PORT);
        std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
    });
    let (target, route) = match direct {
        Some(ip) => (ip.to_string(), format!("direct LAN ({ip})")),
        // RustDesk's public ID server now refuses connections unless the user logs in, so only use the
        // ID route when it can work: a self-hosted server is configured, or there is no LAN address.
        None if lan_ip.is_none() || rustdesk_has_custom_server() => (peer.clone(), format!("RustDesk ID {peer}")),
        None => {
            return Err(format!(
                "Can't reach RustDesk directly at {} (port {RUSTDESK_DIRECT_PORT}). On that computer, open RustDesk \
                 and turn on Settings > Security > Enable direct IP access (then quit and reopen RustDesk). \
                 BridgeDeck doesn't fall back to RustDesk's public ID server because it now requires a login.",
                lan_ip.map(|ip| ip.to_string()).unwrap_or_default()
            ))
        }
    };
    Command::new(path).args([flag, &target]).spawn().map_err(|e| e.to_string())?;
    Ok(route)
}

/// True when RustDesk is pointed at a self-hosted ID/relay server instead of the public one.
fn rustdesk_has_custom_server() -> bool {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let candidates = [
        std::env::var("APPDATA").map(|d| PathBuf::from(d).join("RustDesk/config/RustDesk2.toml")).unwrap_or_default(),
        PathBuf::from(&home).join("Library/Preferences/com.carriez.RustDesk/RustDesk2.toml"),
        PathBuf::from(&home).join(".config/rustdesk/RustDesk2.toml"),
    ];
    candidates.iter().filter_map(|p| fs::read_to_string(p).ok()).any(|raw| {
        raw.lines().any(|line| {
            let line = line.trim();
            line.starts_with("custom-rendezvous-server")
                && line.split_once('=').is_some_and(|(_, v)| !v.trim().trim_matches('\'').trim_matches('"').is_empty())
        })
    })
}

fn rustdesk_process_running() -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
        .processes()
        .values()
        .any(|p| p.name().to_string_lossy().to_ascii_lowercase().starts_with("rustdesk"))
}

/// Keeps RustDesk running alongside BridgeDeck so the paired computer can always connect.
/// Starts it in the background when it is not running; never stops it.
#[tauri::command]
async fn rustdesk_ensure_running(app: AppHandle, executable: Option<String>) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        if rustdesk_process_running() {
            return serde_json::json!({ "running": true, "started": false });
        }
        let Some(path) = resolve_rustdesk_executable(&app, executable) else {
            return serde_json::json!({ "running": false, "started": false, "detail": "RustDesk is not installed" });
        };
        let launched = launch_rustdesk_background(&path);
        std::thread::sleep(Duration::from_secs(2));
        serde_json::json!({
            "running": rustdesk_process_running(),
            "started": launched.is_ok(),
            "detail": launched.err(),
        })
    })
    .await
    .unwrap_or_else(|e| serde_json::json!({ "running": false, "started": false, "detail": e.to_string() }))
}

/// Keeps BlueBubbles Server running on the Mac while BridgeDeck runs (it hosts iMessage for the
/// Windows Messages page). A no-op elsewhere: the server only exists for macOS.
#[tauri::command]
async fn bluebubbles_ensure_running() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(|| {
            let running = |system: &mut sysinfo::System| {
                system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                system.processes().values().any(|p| p.name().to_string_lossy().to_ascii_lowercase().starts_with("bluebubbles"))
            };
            let mut system = sysinfo::System::new();
            if running(&mut system) {
                return serde_json::json!({ "running": true, "started": false });
            }
            let home = std::env::var("HOME").unwrap_or_default();
            let bundle = [PathBuf::from("/Applications/BlueBubbles.app"), PathBuf::from(home).join("Applications/BlueBubbles.app")]
                .into_iter()
                .find(|p| p.exists());
            let Some(bundle) = bundle else {
                return serde_json::json!({ "running": false, "started": false, "detail": "BlueBubbles Server is not installed" });
            };
            let status = Command::new("open").args(["-g", "-j", "-a"]).arg(&bundle).status();
            std::thread::sleep(Duration::from_secs(2));
            serde_json::json!({ "running": running(&mut system), "started": status.map(|s| s.success()).unwrap_or(false) })
        })
        .await
        .unwrap_or_else(|e| serde_json::json!({ "running": false, "started": false, "detail": e.to_string() }));
    }
    #[allow(unreachable_code)]
    serde_json::json!({ "running": false, "started": false, "detail": "BlueBubbles Server runs on the Mac" })
}

#[cfg(target_os = "windows")]
fn launch_rustdesk_background(path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Installed RustDesk runs its server as the "RustDesk" service; the tray is the user-side agent.
    // Starting the service may need admin rights, so a failure there is not fatal.
    let service_installed = Command::new("sc").args(["query", "RustDesk"]).creation_flags(CREATE_NO_WINDOW)
        .output().map(|o| o.status.success()).unwrap_or(false);
    if service_installed {
        let _ = Command::new("sc").args(["start", "RustDesk"]).creation_flags(CREATE_NO_WINDOW).output();
        Command::new(path).arg("--tray").spawn().map(|_| ()).map_err(|e| e.to_string())
    } else {
        // Portable RustDesk: the main app hosts the server.
        Command::new(path).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
fn launch_rustdesk_background(path: &str) -> Result<(), String> {
    // `open -g -j` launches the app bundle without focusing it and with its windows hidden.
    let bundle = path.find(".app/").map(|i| &path[..i + 4]).unwrap_or(path);
    let status = Command::new("open").args(["-g", "-j", "-a", bundle]).status().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("open exited with {status}")) }
}

#[cfg(target_os = "linux")]
fn launch_rustdesk_background(path: &str) -> Result<(), String> {
    Command::new(path).arg("--tray").spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn rustdesk_identity(app: AppHandle, executable: Option<String>) -> RustDeskIdentity {
    let Some(path) = resolve_rustdesk_executable(&app, executable) else {
        return RustDeskIdentity { available: false, id: None, executable: None, detail: Some("RustDesk runtime not found".into()) };
    };
    match Command::new(&path).arg("--get-id").output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let id = stdout.split_whitespace().find(|part| part.chars().all(|c| c.is_ascii_digit()) && part.len() >= 6).map(str::to_string);
            RustDeskIdentity {
                available: true,
                id,
                executable: Some(path),
                detail: if output.status.success() { None } else { Some(String::from_utf8_lossy(&output.stderr).trim().to_string()) },
            }
        }
        Err(error) => RustDeskIdentity { available: true, id: None, executable: Some(path), detail: Some(error.to_string()) },
    }
}


fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config-v7.json"))
}

#[tauri::command]
fn load_app_config(app: AppHandle) -> Result<Option<String>, String> {
    let path = config_path(&app)?;
    if path.exists() {
        return fs::read_to_string(path).map(Some).map_err(|e| e.to_string());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    for legacy_name in ["config-v6.json", "config-v5.json", "config-v4.json", "config-v3.json"] {
        let legacy = dir.join(legacy_name);
        if legacy.exists() {
            return fs::read_to_string(legacy).map(Some).map_err(|e| e.to_string());
        }
    }
    Ok(None)
}

#[tauri::command]
fn save_app_config(app: AppHandle, raw: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| format!("Invalid config JSON: {e}"))?;
    let path = config_path(&app)?;
    fs::write(&path, raw).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn service_snapshot(
    app: &AppHandle,
    service_id: &str,
    explicit: Option<String>,
    manager: &ServiceManager,
) -> Result<ManagedServiceState, String> {
    if !allowed_service(service_id) {
        return Err("Unknown service ID".into());
    }
    let resolved = resolve_runtime_executable(app, service_id, explicit);
    let ready = resolved.is_some();
    let mut children = manager.children.lock().map_err(|_| "Service manager lock poisoned")?;
    let mut running = false;
    let mut pid = None;
    if let Some(child) = children.get_mut(service_id) {
        match child.try_wait().map_err(|e| e.to_string())? {
            None => {
                running = true;
                pid = Some(child.id());
            }
            Some(_) => {
                children.remove(service_id);
            }
        }
    }
    Ok(ManagedServiceState {
        service_id: service_id.to_string(),
        running,
        managed: running,
        pid,
        executable_ready: ready,
        executable: resolved,
        detail: if !manageable_service(service_id) {
            Some("This component is API-driven and is not started as a local process by BridgeDeck.".into())
        } else if !ready {
            Some("Import a runtime into runtime/<platform>/... or set a direct executable path in Settings.".into())
        } else if running {
            Some("Started and tracked by BridgeDeck.".into())
        } else {
            Some("Runtime is ready but not currently started by BridgeDeck.".into())
        },
    })
}

#[tauri::command]
fn managed_service_status(
    app: AppHandle,
    service_id: String,
    executable: Option<String>,
    manager: State<'_, ServiceManager>,
) -> Result<ManagedServiceState, String> {
    service_snapshot(&app, &service_id, executable, manager.inner())
}

#[tauri::command]
fn managed_service_start(
    app: AppHandle,
    service_id: String,
    executable: Option<String>,
    manager: State<'_, ServiceManager>,
) -> Result<ManagedServiceState, String> {
    if !manageable_service(&service_id) {
        return Err("This component is not a BridgeDeck-managed local process".into());
    }
    let path = resolve_runtime_executable(&app, &service_id, executable.clone())
        .ok_or("Import a bundled runtime or set a direct runtime executable path first")?;

    {
        let mut children = manager.children.lock().map_err(|_| "Service manager lock poisoned")?;
        if let Some(child) = children.get_mut(&service_id) {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                drop(children);
                return service_snapshot(&app, &service_id, executable, manager.inner());
            }
            children.remove(&service_id);
        }

        let mut command = Command::new(&path);
        if service_id == "syncthing" {
            command.arg("--no-browser");
        }
        let child = command.spawn().map_err(|e| e.to_string())?;
        children.insert(service_id.clone(), child);
    }
    service_snapshot(&app, &service_id, executable, manager.inner())
}

#[tauri::command]
fn managed_service_stop(
    app: AppHandle,
    service_id: String,
    manager: State<'_, ServiceManager>,
) -> Result<ManagedServiceState, String> {
    if !allowed_service(&service_id) {
        return Err("Unknown service ID".into());
    }
    let mut children = manager.children.lock().map_err(|_| "Service manager lock poisoned")?;
    if let Some(mut child) = children.remove(&service_id) {
        child.kill().map_err(|e| e.to_string())?;
        let _ = child.wait();
    }
    drop(children);
    service_snapshot(&app, &service_id, None, manager.inner())
}

fn checked_http_base(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("URL must start with http:// or https://".into());
    }
    Ok(base.to_string())
}

/// Saves a contact edit (see `bridgelink::ContactSaveRequest`). On the Mac it is written to the Contacts
/// app directly; elsewhere it is sent to the paired Mac. Returns the Contacts person id.
#[tauri::command]
async fn contacts_save(request: bridgelink::ContactSaveRequest, manager: State<'_, BridgeLinkManager>) -> Result<String, String> {
    request.validate()?;
    let manager = BridgeLinkManager::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || {
        if cfg!(target_os = "macos") { save_apple_contact(&request) } else { bridgelink::forward_contact_save(&manager, &request) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes a contact edit to macOS Contacts through AppleScript. Values travel as `argv` (never spliced
/// into the script), so names and numbers cannot inject AppleScript. The first run triggers macOS's
/// "BridgeDeck wants to control Contacts" prompt.
#[cfg(target_os = "macos")]
pub(crate) fn save_apple_contact(request: &bridgelink::ContactSaveRequest) -> Result<String, String> {
    const SCRIPT: &str = r#"on run argv
	set personId to item 1 of argv
	set firstN to item 2 of argv
	set lastN to item 3 of argv
	set phonesAdd to paragraphs of item 4 of argv
	set phonesRemove to paragraphs of item 5 of argv
	set emailsAdd to paragraphs of item 6 of argv
	set emailsRemove to paragraphs of item 7 of argv
	tell application "Contacts"
		if personId is "" then
			set p to make new person with properties {first name:firstN, last name:lastN}
		else
			set p to person id personId
			set first name of p to firstN
			set last name of p to lastN
		end if
		repeat with v in phonesRemove
			set x to contents of v
			if x is not "" then
				try
					delete (every phone of p whose value is x)
				end try
			end if
		end repeat
		repeat with v in phonesAdd
			set x to contents of v
			if x is not "" then make new phone at end of phones of p with properties {label:"mobile", value:x}
		end repeat
		repeat with v in emailsRemove
			set x to contents of v
			if x is not "" then
				try
					delete (every email of p whose value is x)
				end try
			end if
		end repeat
		repeat with v in emailsAdd
			set x to contents of v
			if x is not "" then make new email at end of emails of p with properties {label:"home", value:x}
		end repeat
		save
		return id of p
	end tell
end run"#;
    request.validate()?;
    let output = Command::new("osascript")
        .arg("-e").arg(SCRIPT)
        .arg(&request.person_id)
        .arg(request.first_name.trim())
        .arg(request.last_name.trim())
        .arg(request.phones_add.join("\n"))
        .arg(request.phones_remove.join("\n"))
        .arg(request.emails_add.join("\n"))
        .arg(request.emails_remove.join("\n"))
        .output()
        .map_err(|e| format!("Could not run osascript: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.contains("-1743") || err.to_lowercase().contains("not authorized") {
            "BridgeDeck isn't allowed to control Contacts. On the Mac: System Settings > Privacy & Security > Automation > BridgeDeck > Contacts.".into()
        } else {
            format!("Contacts refused the change: {err}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn save_apple_contact(_request: &bridgelink::ContactSaveRequest) -> Result<String, String> {
    Err("Contacts can only be edited on the Mac".into())
}
/// Desktop notification from the UI (new iMessages). Title and body are plain text, length-limited.
#[tauri::command]
fn desktop_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let title: String = title.chars().take(80).collect();
    let body: String = body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(240).collect();
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

/// Port of a BlueBubbles Server running on this computer (the Mac), if any.
#[tauri::command]
fn bluebubbles_local_port() -> Option<u16> {
    bridgelink::local_bluebubbles_port()
}

/// reqwest error text without the request URL. BlueBubbles authenticates with a `password` query
/// parameter, so the URL must never reach the UI, notifications or logs.
fn net_err(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())
}

fn bluebubbles_url(base_url: &str, endpoint: &str) -> Result<reqwest::Url, String> {
    let base = checked_http_base(base_url)?;
    reqwest::Url::parse(&format!("{}/api/v1/{}", base, endpoint.trim_start_matches('/'))).map_err(|e| e.to_string())
}

#[tauri::command]
async fn bluebubbles_ping(base_url: String, password: String) -> Result<bool, String> {
    let url = bluebubbles_url(&base_url, "server/info")?;
    let response = http_client()?.get(url).query(&[("password", password)]).send().await.map_err(net_err)?;
    Ok(response.status().is_success())
}

#[tauri::command]
async fn bluebubbles_chats(base_url: String, password: String, limit: u32) -> Result<serde_json::Value, String> {
    let url = bluebubbles_url(&base_url, "chat/query")?;
    // Participants and the last message drive the conversation list (names, preview, time).
    let body = serde_json::json!({ "limit": limit.min(200), "with": ["participants", "lastMessage"], "sort": "lastmessage" });
    let response = http_client()?.post(url).query(&[("password", password)]).json(&body).send().await.map_err(net_err)?;
    let status = response.status();
    let value = response.json::<serde_json::Value>().await.map_err(net_err)?;
    if !status.is_success() { return Err(format!("BlueBubbles returned HTTP {}", status)); }
    Ok(value)
}

/// Messages of one chat, newest first. Uses `GET chat/:guid/message`: `POST message/query` ignores a
/// bare `chatGuid` and returned nothing, which left every conversation empty.
#[tauri::command]
async fn bluebubbles_messages(base_url: String, password: String, chat_guid: String, limit: u32) -> Result<serde_json::Value, String> {
    let mut url = reqwest::Url::parse(&format!("{}/", checked_http_base(&base_url)?)).map_err(|e| e.to_string())?;
    {
        // Path-segment encoding keeps chat GUIDs such as "iMessage;-;+15551234567" intact.
        let mut path = url.path_segments_mut().map_err(|_| "Invalid BlueBubbles URL")?;
        path.pop_if_empty().extend(["api", "v1", "chat", chat_guid.as_str(), "message"]);
    }
    let limit = limit.clamp(1, 200).to_string();
    let response = http_client()?.get(url)
        .query(&[("password", password.as_str()), ("limit", limit.as_str()), ("sort", "DESC"), ("with", "handle,attachment")])
        .send().await.map_err(net_err)?;
    let status = response.status();
    let value = response.json::<serde_json::Value>().await.map_err(net_err)?;
    if !status.is_success() { return Err(format!("BlueBubbles returned HTTP {}", status)); }
    Ok(value)
}

/// The Mac's Contacts as BlueBubbles exposes them (names, phone numbers, emails, avatars).
#[tauri::command]
async fn bluebubbles_contacts(base_url: String, password: String) -> Result<serde_json::Value, String> {
    let url = bluebubbles_url(&base_url, "contact")?;
    // Photos are only included on request.
    let response = http_client()?.get(url).query(&[("password", password.as_str()), ("extraProperties", "avatar")]).send().await.map_err(net_err)?;
    let status = response.status();
    let value = response.json::<serde_json::Value>().await.map_err(net_err)?;
    if !status.is_success() { return Err(format!("BlueBubbles returned HTTP {}", status)); }
    Ok(value)
}

/// Downloads an image attachment and returns it as a `data:` URL for inline display.
#[tauri::command]
async fn bluebubbles_attachment(base_url: String, password: String, attachment_guid: String) -> Result<String, String> {
    use base64::Engine;
    const MAX_BYTES: usize = 12 * 1024 * 1024;
    let mut url = reqwest::Url::parse(&format!("{}/", checked_http_base(&base_url)?)).map_err(|e| e.to_string())?;
    {
        let mut path = url.path_segments_mut().map_err(|_| "Invalid BlueBubbles URL")?;
        path.pop_if_empty().extend(["api", "v1", "attachment", attachment_guid.as_str(), "download"]);
    }
    // Ask for a JPEG rendition so HEIC photos from iPhones display in the WebView.
    let response = http_client()?.get(url).query(&[("password", password.as_str()), ("width", "800"), ("quality", "better")])
        .send().await.map_err(net_err)?;
    if !response.status().is_success() { return Err(format!("BlueBubbles returned HTTP {}", response.status())); }
    let mime = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
    if !mime.starts_with("image/") { return Err(format!("Not an image ({mime})")); }
    let bytes = response.bytes().await.map_err(net_err)?;
    if bytes.len() > MAX_BYTES { return Err("Image too large to preview".into()); }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

#[tauri::command]
async fn bluebubbles_send(base_url: String, password: String, chat_guid: String, message: String) -> Result<serde_json::Value, String> {
    if message.trim().is_empty() { return Err("Message is empty".into()); }
    let url = bluebubbles_url(&base_url, "message/text")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let temp_guid = format!("bridgedeck-{}-{}", now, std::process::id());
    let response = http_client()?.post(url).query(&[("password", password)]).json(&serde_json::json!({ "chatGuid": chat_guid, "tempGuid": temp_guid, "message": message })).send().await.map_err(net_err)?;
    let status = response.status();
    let value = response.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        // Pass the server's reason through (e.g. AppleScript -1728 for SMS without Text Message Forwarding).
        let reason = value.pointer("/error/message").or_else(|| value.get("message")).and_then(|v| v.as_str()).unwrap_or("");
        return Err(if reason.is_empty() { format!("BlueBubbles returned HTTP {status}") } else { format!("Not sent: {reason}") });
    }
    Ok(value)
}

/// Server-wide message feed, newest first, each with its chat and participants. The conversation
/// list is built from this because `chat/query`'s lastMessage ordering is unreliable on 1.9.9
/// (it fails to decode some chats and lists recently active chats far down).
#[tauri::command]
async fn bluebubbles_recent(base_url: String, password: String, after: u64, limit: u32) -> Result<serde_json::Value, String> {
    let url = bluebubbles_url(&base_url, "message/query")?;
    let body = serde_json::json!({
        "limit": limit.clamp(1, 1000),
        "sort": "DESC",
        "after": after,
        "with": ["chat", "chat.participants", "handle", "attachment"],
    });
    let response = http_client()?.post(url).query(&[("password", password)]).json(&body).send().await.map_err(net_err)?;
    let status = response.status();
    let value = response.json::<serde_json::Value>().await.map_err(net_err)?;
    if !status.is_success() { return Err(format!("BlueBubbles returned HTTP {}", status)); }
    Ok(value)
}

#[tauri::command]
async fn syncthing_status(base_url: String, api_key: String) -> Result<SyncthingStatus, String> {
    let base = checked_http_base(&base_url)?;
    if api_key.trim().is_empty() {
        return Ok(SyncthingStatus { ok: false, my_id: None, uptime: None, alloc: None, sys: None, goroutines: None, error: Some("Add the Syncthing API key in Settings.".into()) });
    }
    let response = http_client()?.get(format!("{base}/rest/system/status")).header("X-API-Key", api_key).send().await.map_err(net_err)?;
    let status = response.status();
    let value = response.json::<serde_json::Value>().await.map_err(net_err)?;
    if !status.is_success() {
        return Ok(SyncthingStatus { ok: false, my_id: None, uptime: None, alloc: None, sys: None, goroutines: None, error: Some(format!("Syncthing returned HTTP {}", status)) });
    }
    Ok(SyncthingStatus {
        ok: true,
        my_id: value.get("myID").and_then(|v| v.as_str()).map(str::to_string),
        uptime: value.get("uptime").and_then(|v| v.as_u64()),
        alloc: value.get("alloc").and_then(|v| v.as_u64()),
        sys: value.get("sys").and_then(|v| v.as_u64()),
        goroutines: value.get("goroutines").and_then(|v| v.as_u64()),
        error: None,
    })
}

#[tauri::command]
async fn syncthing_folders(base_url: String, api_key: String) -> Result<Vec<SyncthingFolder>, String> {
    let base = checked_http_base(&base_url)?;
    if api_key.trim().is_empty() { return Ok(Vec::new()); }
    let response = http_client()?.get(format!("{base}/rest/config/folders")).header("X-API-Key", api_key).send().await.map_err(net_err)?;
    let status = response.status();
    let values = response.json::<Vec<serde_json::Value>>().await.map_err(net_err)?;
    if !status.is_success() { return Err(format!("Syncthing returned HTTP {}", status)); }
    Ok(values.into_iter().filter_map(|v| {
        let id = v.get("id")?.as_str()?.to_string();
        Some(SyncthingFolder {
            id,
            label: v.get("label").and_then(|x| x.as_str()).map(str::to_string),
            path: v.get("path").and_then(|x| x.as_str()).map(str::to_string),
            paused: v.get("paused").and_then(|x| x.as_bool()),
            r#type: v.get("type").and_then(|x| x.as_str()).map(str::to_string),
        })
    }).collect())
}

fn matrix_url(homeserver: &str, segments: &[&str]) -> Result<reqwest::Url, String> {
    let base = checked_http_base(homeserver)?;
    let mut url = reqwest::Url::parse(&format!("{base}/")).map_err(|e| e.to_string())?;
    {
        let mut path = url.path_segments_mut().map_err(|_| "Invalid Matrix homeserver URL")?;
        path.clear();
        for segment in segments { path.push(segment); }
    }
    Ok(url)
}

#[tauri::command]
async fn matrix_messages(homeserver: String, room_id: String, access_token: String, limit: u32) -> Result<Vec<MatrixMessage>, String> {
    if room_id.trim().is_empty() || access_token.trim().is_empty() { return Ok(Vec::new()); }
    let mut url = matrix_url(&homeserver, &["_matrix", "client", "v3", "rooms", &room_id, "messages"])?;
    url.query_pairs_mut().append_pair("dir", "b").append_pair("limit", &limit.min(100).to_string());
    let response = http_client()?.get(url).bearer_auth(access_token).send().await.map_err(net_err)?;
    let status = response.status();
    let value = response.json::<serde_json::Value>().await.map_err(net_err)?;
    if !status.is_success() { return Err(format!("Matrix returned HTTP {}", status)); }
    let mut messages = Vec::new();
    if let Some(chunk) = value.get("chunk").and_then(|v| v.as_array()) {
        for event in chunk.iter().rev() {
            if event.get("type").and_then(|v| v.as_str()) != Some("m.room.message") { continue; }
            let Some(body) = event.get("content").and_then(|v| v.get("body")).and_then(|v| v.as_str()) else { continue; };
            messages.push(MatrixMessage {
                event_id: event.get("event_id").and_then(|v| v.as_str()).map(str::to_string),
                sender: event.get("sender").and_then(|v| v.as_str()).map(str::to_string),
                body: Some(body.to_string()),
                timestamp: event.get("origin_server_ts").and_then(|v| v.as_u64()),
                mine: false,
            });
        }
    }
    Ok(messages)
}

#[tauri::command]
async fn matrix_send(homeserver: String, room_id: String, access_token: String, body: String) -> Result<bool, String> {
    if room_id.trim().is_empty() || access_token.trim().is_empty() || body.trim().is_empty() {
        return Err("Matrix settings or message are incomplete".into());
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let txn_id = format!("bridgedeck-{now}-{}", std::process::id());
    let url = matrix_url(&homeserver, &["_matrix", "client", "v3", "rooms", &room_id, "send", "m.room.message", &txn_id])?;
    let response = http_client()?.put(url).bearer_auth(access_token).json(&serde_json::json!({ "msgtype": "m.text", "body": body })).send().await.map_err(net_err)?;
    if !response.status().is_success() { return Err(format!("Matrix returned HTTP {}", response.status())); }
    Ok(true)
}

/// Starts BridgeLink from the saved native config (`config-v7.json`), honouring `pairing.autoStart`.
/// The UI later calls `bridgelink_start` again, which only refreshes the advertised details.
fn autostart_bridgelink(app: &AppHandle) {
    let config = config_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or(serde_json::Value::Null);
    if config.pointer("/pairing/autoStart").and_then(|v| v.as_bool()) == Some(false) {
        return;
    }
    let text = |pointer: &str| config.pointer(pointer).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let port = |pointer: &str| config.pointer(pointer).and_then(|v| v.as_u64()).and_then(|v| u16::try_from(v).ok()).unwrap_or(0);
    let rustdesk_exe = config.pointer("/services").and_then(|v| v.as_array())
        .and_then(|list| list.iter().find(|s| s.get("id").and_then(|v| v.as_str()) == Some("rustdesk")))
        .and_then(|s| s.get("executable")).and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty()).map(str::to_string);
    let rustdesk_id = rustdesk_identity(app.clone(), rustdesk_exe).id.unwrap_or_default();
    let manager = app.state::<BridgeLinkManager>();
    let _ = bridgelink::start(app, &manager, text("/pairing/displayName"), port("/pairing/apiPort"), rustdesk_id, port("/localsend/port"), String::new());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ServiceManager { children: Mutex::new(HashMap::new()) })
        .manage(LocalSendManager::default())
        .manage(BridgeLinkManager::default())
        .setup(|app| {
            // Start BridgeLink with the process, not when the window's UI loads: a hidden or
            // login-item launch must still be reachable for pairing status and the AI relay.
            let handle = app.handle().clone();
            std::thread::spawn(move || autostart_bridgelink(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_tcp,
            open_external,
            open_path,
            app_available,
            launch_app,
            rustdesk_session,
            agent_status,
            rustdesk_ensure_running,
            bluebubbles_ensure_running,
            bluebubbles_contacts,
            bluebubbles_local_port,
            desktop_notify,
            contacts_save,
            bluebubbles_recent,
            bluebubbles_attachment,
            source_update_status,
            rustdesk_identity,
            localsend_bridge::localsend_receiver_status,
            localsend_bridge::localsend_set_trusted_hosts,
            localsend_bridge::localsend_receiver_start,
            localsend_bridge::localsend_receiver_stop,
            localsend_bridge::localsend_accept,
            localsend_bridge::localsend_decline,
            localsend_bridge::localsend_send_native,
            bridgelink::bridgelink_start,
            bridgelink::bridgelink_stop,
            bridgelink::bridgelink_status,
            bridgelink::bridgelink_request_pair,
            bridgelink::bridgelink_poll_pair,
            bridgelink::bridgelink_approve,
            bridgelink::bridgelink_decline,
            bridgelink::bridgelink_forget,
            bridgelink::bridgelink_refresh_peer,
            bridgelink::bridgelink_ai_messages,
            bridgelink::bridgelink_ai_send,
            bridgelink::bridgelink_ai_token_path,
            load_app_config,
            save_app_config,
            managed_service_status,
            managed_service_start,
            managed_service_stop,
            bluebubbles_ping,
            bluebubbles_chats,
            bluebubbles_messages,
            bluebubbles_send,
            syncthing_status,
            syncthing_folders,
            syncthing_bridge::syncthing_setup_peer,
            matrix_messages,
            matrix_send
        ])
        .run(tauri::generate_context!())
        .expect("error while running BridgeDeck");
}
