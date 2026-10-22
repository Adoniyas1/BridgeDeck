mod localsend_bridge;
mod bridgelink;
mod clipboard;
mod diagnostics;
mod health;
mod syncthing_bridge;
mod secrets;
mod transfer;
mod tray;
mod imessage;
mod legacy_apps;
mod link;
mod mimir_host;
mod remote;
mod send_to;
mod browser;
mod placement;
mod adblock;
mod extensions;
mod backups;
mod canvas;
mod activity;
mod circuits;
mod hardware;
mod watchdog;
mod code;
mod octave;
#[cfg(debug_assertions)]
mod dev_fallback;
mod errorlog;
mod python;
mod spotify;
mod phone;
mod note_history;
mod webkeys;
mod webmedia;
mod models;
mod drawings;
mod chatgpt;
mod manga;
mod projects;
mod skill_packs;
mod study;
mod scan_pdf;
mod study_slides;
mod study_state;
mod sync_conflicts;
mod sync_sidecar;
mod upgrade;
mod wake;
use localsend_bridge::LocalSendManager;
use bridgelink::BridgeLinkManager;
use serde::Serialize;
use std::{
    fs,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

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
    match service_id {
        "syncthing" if cfg!(target_os = "windows") => Some("syncthing.exe"),
        "syncthing" => Some("syncthing"),
        _ => None,
    }
}

pub(crate) fn bundled_runtime_path(app: &AppHandle, service_id: &str) -> Option<PathBuf> {
    let filename = runtime_filename(service_id)?;
    let rel = PathBuf::from("runtime").join(platform_key()).join(service_id).join(filename);

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join(&rel);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // During `tauri dev`, Cargo runs from `src-tauri/`, while built helper
    // binaries live at the repository root under `runtime/`.
    let source_runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(&rel);
    if source_runtime.exists() {
        return Some(source_runtime);
    }

    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join(&rel);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[tauri::command]
fn probe_tcp(host: String, port: u16) -> bool {
    let Ok(mut addrs) = format!("{}:{}", host, port).to_socket_addrs() else { return false; };
    let Some(addr): Option<SocketAddr> = addrs.next() else { return false; };
    TcpStream::connect_timeout(&addr, Duration::from_millis(850)).is_ok()
}

/// Opens an http(s) link in the default browser, or a mailto: link in the mail app. The URL is parsed
/// and re-serialized, and the opener plugin launches it without a shell, so shell metacharacters in a
/// link can't run commands.
#[tauri::command]
fn open_external(app: AppHandle, target: String) -> Result<(), String> {
    let url = reqwest::Url::parse(target.trim()).map_err(|_| "Not a valid URL".to_string())?;
    let web = matches!(url.scheme(), "http" | "https") && url.host_str().is_some();
    let mail = url.scheme() == "mailto" && url.path().contains('@') && !url.path().contains(['\\', '\n', '\r']);
    if !web && !mail {
        return Err("Only http/https and mailto links are allowed".into());
    }
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
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

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config-v7.json"))
}

fn read_saved_config(app: &AppHandle) -> Result<Option<String>, String> {
    let path = config_path(app)?;
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

/// The synced folder from the saved settings ("" means the default).
pub(crate) fn shared_folder(app: &AppHandle) -> String {
    read_saved_config(app)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|config| config.pointer("/syncthing/sharedFolderPath").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_default()
}

fn write_saved_config(app: &AppHandle, contents: &str) -> Result<(), String> {
    let path = config_path(app)?;
    fs::write(&path, contents).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Returns the settings with their secrets filled in from the OS credential store. Settings saved by
/// older builds still hold secrets in plain text; those are moved into the credential store and
/// removed from the file here.
#[tauri::command]
fn load_app_config(app: AppHandle) -> Result<Option<String>, String> {
    let Some(raw) = read_saved_config(&app)? else { return Ok(None) };
    let Ok(mut config) = serde_json::from_str::<serde_json::Value>(&raw) else { return Ok(Some(raw)) };
    let plaintext = secrets::split(&mut config);
    let mut stored = secrets::load().unwrap_or_else(|error| {
        eprintln!("BridgeDeck: could not read settings secrets from the credential store: {error}");
        secrets::Secrets::new()
    });
    if !plaintext.is_empty() {
        stored.extend(plaintext);
        if secrets::store(&stored).is_ok() {
            write_saved_config(&app, &config.to_string())?;
        }
    }
    secrets::merge(&mut config, &stored);
    Ok(Some(config.to_string()))
}

/// Saves the settings without their secrets, which go to the OS credential store. If the credential
/// store is unavailable the settings are saved with secrets in the file, as older builds did.
#[tauri::command]
fn save_app_config(app: AppHandle, raw: String) -> Result<(), String> {
    let mut config = serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| format!("Invalid config JSON: {e}"))?;
    let secrets = secrets::split(&mut config);
    match secrets::store(&secrets) {
        Ok(()) => write_saved_config(&app, &config.to_string()),
        Err(error) => {
            eprintln!("BridgeDeck: keeping settings secrets in the settings file: {error}");
            write_saved_config(&app, &raw)
        }
    }
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
    imessage::forget_contacts();
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

/// reqwest error text without the request URL (URLs can carry keys or tokens), for the UI and logs.
/// Which notifications the native side shows itself (the rest are sent by the UI).
#[tauri::command]
fn notification_settings(ai: bool) {
    bridgelink::AI_NOTIFICATIONS.store(ai, std::sync::atomic::Ordering::Relaxed);
}

fn net_err(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())
}

/// True for http(s) URLs on this computer. Syncthing's API key never leaves the computer (audit MEDIUM).
pub(crate) fn is_loopback_url(url: &str) -> bool {
    reqwest::Url::parse(url.trim()).ok().is_some_and(|u| {
        matches!(u.scheme(), "http" | "https")
            && match u.host() {
                Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            }
    })
}

fn checked_syncthing_base(base_url: &str) -> Result<String, String> {
    if !is_loopback_url(base_url) {
        return Err("BridgeDeck only talks to Syncthing on this computer (127.0.0.1)".into());
    }
    checked_http_base(base_url)
}

/// Any Syncthing REST call (`/rest/...`) on this computer, for the Sync tab.
#[tauri::command]
async fn syncthing_request(base_url: String, api_key: String, method: String, path: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let base = checked_syncthing_base(&base_url)?;
    if !path.starts_with("/rest/") || path.contains("..") {
        return Err("Only Syncthing REST paths are allowed".into());
    }
    let method = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Unsupported method".into()),
    };
    let mut request = http_client()?.request(method, format!("{base}{path}")).header("X-API-Key", api_key.trim());
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(net_err)?;
    let status = response.status();
    let text = response.text().await.map_err(net_err)?;
    if !status.is_success() {
        return Err(format!("Syncthing returned HTTP {status}: {}", text.trim()));
    }
    Ok(if text.trim().is_empty() { serde_json::Value::Null } else { serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text)) })
}

#[tauri::command]
async fn syncthing_status(base_url: String, api_key: String) -> Result<SyncthingStatus, String> {
    let base = checked_syncthing_base(&base_url)?;
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
    let base = checked_syncthing_base(&base_url)?;
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
    let manager = app.state::<BridgeLinkManager>();
    let _ = bridgelink::start(app, &manager, text("/pairing/displayName"), port("/pairing/apiPort"), port("/localsend/port"), String::new());
}

/// This computer's upgrade capabilities and the last upgrade's progress.
#[tauri::command]
fn upgrade_info(app: AppHandle) -> upgrade::UpgradeInfo {
    upgrade::info(&app)
}

/// Pulls the latest main from GitHub, rebuilds and reinstalls BridgeDeck on this computer.
#[tauri::command]
fn upgrade_self(app: AppHandle) -> Result<(), String> {
    upgrade::start(&app, upgrade::UpgradeMode::Git, None, "this computer")
}

/// Installs the latest ready-built release from GitHub (no rebuild).
#[tauri::command]
fn upgrade_release(app: AppHandle) -> Result<(), String> {
    upgrade::start(&app, upgrade::UpgradeMode::Release, None, "this computer")
}

/// macOS: sets up the local signing certificate so permissions stay after updates.
#[tauri::command]
async fn upgrade_setup_signing() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(upgrade::setup_signing).await.map_err(|e| e.to_string())?
}

/// Whether GitHub has changes this computer doesn't (checked every few hours by the UI).
#[tauri::command]
async fn upgrade_check() -> Result<upgrade::UpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(upgrade::check_for_update).await.map_err(|e| e.to_string())?
}

/// Packs this computer's source for sending to the paired computer ("Send my source").
#[tauri::command]
async fn upgrade_create_bundle(app: AppHandle) -> Result<upgrade::SourceBundle, String> {
    tauri::async_runtime::spawn_blocking(move || upgrade::create_source_bundle(&app)).await.map_err(|e| e.to_string())?
}

/// Asks a paired computer to upgrade itself; returns once the user there has allowed or denied it.
#[tauri::command]
async fn upgrade_request_peer(instance_id: String, request: bridgelink::UpgradeRequest, manager: State<'_, BridgeLinkManager>) -> Result<(), String> {
    let manager = BridgeLinkManager::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || bridgelink::forward_upgrade_request(&manager, &instance_id, &request)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn upgrade_peer_status(instance_id: String, manager: State<'_, BridgeLinkManager>) -> Result<serde_json::Value, String> {
    let manager = BridgeLinkManager::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || bridgelink::peer_upgrade_status(&manager, &instance_id)).await.map_err(|e| e.to_string())?
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second start (Explorer's Send to) hands its files to the running BridgeDeck and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = send_to::paths_from_args(args);
            if paths.is_empty() { tray::show_main(app) } else { send_to::deliver(app, paths) }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(LocalSendManager::default())
        .manage(BridgeLinkManager::default())
        .manage(sync_sidecar::SyncSidecar::default())
        .setup(|app| {
            activity::init(app.handle());
            errorlog::init(app.handle());
            #[cfg(debug_assertions)]
            dev_fallback::check(app.handle());
            activity::info("app", &format!("BridgeDeck {} started on {}.", env!("CARGO_PKG_VERSION"), sysinfo::System::long_os_version().unwrap_or_default()));
            // What it's running on (nvidia-smi can take a moment, so not in the way of starting up).
            std::thread::spawn(|| activity::info("hardware", &hardware::summary(&hardware::read())));
            watchdog::start(app.handle());
            sync_sidecar::init(app.handle());
            transfer::init(app.handle());
            study::init(app.handle());
            models::init(app.handle());
            backups::init(app.handle());
            adblock::init(app.handle(), true);
            browser::start_sleeper(app.handle().clone());
            // New messages as they arrive: watched on the Mac, followed from the other computers.
            imessage::watch::start_local(app.handle().clone());
            imessage::watch::start_following(app.handle().clone(), app.state::<BridgeLinkManager>().inner().clone());
            // Start BridgeLink with the process, not when the window's UI loads: a hidden or
            // login-item launch must still be reachable for pairing status and the AI relay.
            let handle = app.handle().clone();
            std::thread::spawn(move || autostart_bridgelink(&handle));
            clipboard::start(app.state::<BridgeLinkManager>().inner().clone());
            tray::install(app)?;
            send_to::deliver(app.handle(), send_to::paths_from_args(std::env::args()));
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        // Textbooks for the Study reader, from the library folder only (see study.rs).
        .register_uri_scheme_protocol(study::SCHEME, |_ctx, request| study::serve(&request))
        .register_uri_scheme_protocol(models::SCHEME, |_ctx, request| models::serve(&request))
        // Manga pages and covers, from the Manga library only (see manga.rs).
        .register_uri_scheme_protocol(manga::SCHEME, |_ctx, request| manga::serve(&request))
        .invoke_handler(tauri::generate_handler![
            probe_tcp,
            open_external,
            open_path,
            agent_status,
            desktop_notify,
            notification_settings,
            tray::tray_update,
            send_to::send_files_pending,
            bridgelink::peer::bridgelink_wake,
            send_to::send_to_integration,
            health::health_permissions,
            health::open_privacy_settings,
            mimir_host::mimir_status,
            diagnostics::diagnostics_report,
            bridgelink::notes::notes_list,
            bridgelink::notes::notes_create,
            bridgelink::notes::notes_save,
            bridgelink::notes::note_version_restore,
            note_history::note_versions,
            note_history::note_version,
            note_history::note_history_clear,
            bridgelink::notes::notes_replace_markdown,
            bridgelink::notes::notes_markdown,
            bridgelink::notes::notes_delete,
            bridgelink::notes::notes_create_markdown,
            study::study_library,
            study::study_add_course,
            study::study_add_books,
            study::study_remove_book,
            study::study_archive_course,
            study::study_delete_course,
            study::study_patch_course_info,
            study::study_export_semester,
            study::study_save_pdf,
            study::study_download_pdf,
            study::study_plan_read,
            study::study_plan_write,
            study_state::study_state_get,
            study_state::study_state_put,
            study::study_save_index,
            study::study_search,
            study::study_slides_pdf,
            projects::projects_list,
            projects::projects_add,
            projects::projects_files,
            projects::projects_import_mimir,
            projects::project_file_read,
            projects::project_file_write,
            skill_packs::skill_packs_status,
            skill_packs::skill_packs_install,
            chatgpt::chatgpt_show,
            chatgpt::chatgpt_hide,
            chatgpt::chatgpt_new,
            chatgpt::chatgpt_save,
            chatgpt::chatgpt_attach_image,
            chatgpt::chatgpt_read,
            browser::browser_show,
            browser::browser_pause,
            models::models_status,
            models::ocr_languages_status,
            models::ocr_languages_download,
            drawings::drawing_load,
            drawings::drawing_save,
            models::models_download,
            models::models_remove,
            adblock::adblock_status,
            adblock::adblock_set,
            adblock::adblock_allow_sites,
            adblock::adblock_update,
            adblock::adblock_options,
            extensions::extensions_list,
            extensions::extensions_add,
            extensions::extensions_remove,
            extensions::extensions_get_ublock,
            browser::browser_hide,
            browser::browser_go,
            browser::browser_fill_code,
            browser::browser_sleep_settings,
            browser::browser_pages_status,
            browser::browser_sleep_now,
            browser::browser_close,
            browser::browser_has,
            browser::exam_sites,
            backups::backups_list,
            canvas::canvas_feed,
            canvas::canvas_api,
            canvas::calendar_subscription,
            phone::phone_settings,
            phone::phone_status,
            phone::phone_new_key,
            phone::phone_publish,
            spotify::spotify_status,
            spotify::spotify_control,
            spotify::spotify_open,
            python::python_status,
            python::python_run,
            errorlog::error_log_read,
            errorlog::error_log_add,
            errorlog::error_log_clear,
            circuits::circuits_list,
            circuits::circuit_load,
            circuits::circuit_save,
            circuits::circuit_delete,
            circuits::circuit_versions,
            circuits::circuit_version_load,
            circuits::report_save,
            activity::activity_read,
            activity::activity_add,
            activity::activity_clear,
            activity::ai_speed_log,
            hardware::hardware_info,
            watchdog::safety_status,
            watchdog::safety_set,
            watchdog::safety_stop_ai,
            code::code_languages,
            code::code_run,
            code::code_start,
            code::code_input,
            code::code_stop,
            code::code_octave_install,
            code::code_files,
            code::code_load,
            code::code_save,
            code::code_delete,
            backups::backup_now,
            backups::backup_restore,
            backups::backup_export,
            backups::backup_import,
            manga::manga_library,
            manga::manga_pages,
            manga::manga_add,
            manga::manga_create_series,
            manga::manga_import_links,
            manga::manga_source_catalog,
            manga::manga_source_chapters,
            manga::manga_stream_link,
            manga::manga_progress,
            manga::manga_bookmark,
            manga::manga_save_meta,
            manga::manga_remove,
            manga::manga_search_details,
            manga::manga_apply_details,
            manga::manga_add_peppercarrot,
            bridgelink::mimir_api::mimir_activity,
            bridgelink::vault::vault_settings,
            transfer::transfer_send,
            transfer::transfers_list,
            transfer::transfer_cancel,
            transfer::transfer_resume,
            transfer::transfers_clear,
            bridgelink::calendar::calendar_list,
            bridgelink::calendar::calendar_save,
            bridgelink::calendar::calendar_delete,
            bridgelink::calendar::calendar_import,
            bridgelink::calendar::calendar_read_ics,
            bridgelink::calendar::calendar_write_ics,
            bridgelink::calendar::calendar_apple,
            bridgelink::calendar::calendar_apple_share,
            mimir_host::mimir_start,
            mimir_host::mimir_stop,
            contacts_save,
            upgrade_info,
            upgrade_release,
            upgrade_setup_signing,
            upgrade_self,
            upgrade_check,
            upgrade_create_bundle,
            upgrade_request_peer,
            upgrade_peer_status,
            source_update_status,
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
            bridgelink::peer::bridgelink_request_pair,
            bridgelink::peer::bridgelink_poll_pair,
            bridgelink::peer::bridgelink_approve,
            bridgelink::peer::bridgelink_decline,
            bridgelink::bridgelink_forget,
            bridgelink::peer::bridgelink_refresh_peer,
            bridgelink::peer::bridgelink_peer_status,
            bridgelink::peer::bridgelink_confirm_pair,
            bridgelink::peer::bridgelink_legacy_upgrade,
            legacy_apps::legacy_apps,
            legacy_apps::legacy_apps_stop,
            imessage::imessage,
            imessage::imessage_attachment,
            imessage::imessage_send_file,
            imessage::watch::imessage_push_status,
            remote::host::remote_host_status,
            remote::host::remote_host_settings,
            clipboard::clipboard_status,
            clipboard::clipboard_settings,
            clipboard::clipboard_history_settings,
            clipboard::clipboard_history,
            clipboard::clipboard_history_clear,
            clipboard::clipboard_put,
            remote::host::remote_host_stop,
            remote::viewer::remote_connect,
            remote::viewer::remote_frame_drawn,
            remote::viewer::remote_input,
            remote::viewer::remote_settings,
            remote::viewer::remote_disconnect,
            bridgelink::workspace::ai_workspace,
            bridgelink::workspace::ai_room_create,
            bridgelink::workspace::ai_room_update,
            bridgelink::workspace::ai_room_remove,
            bridgelink::workspace::ai_task_add,
            bridgelink::workspace::ai_task_update,
            bridgelink::workspace::ai_claim_release,
            bridgelink::bridgelink_ai_messages,
            bridgelink::bridgelink_ai_send,
            bridgelink::bridgelink_ai_token_path,
            load_app_config,
            save_app_config,
            syncthing_status,
            syncthing_folders,
            syncthing_bridge::syncthing_setup_peer,
            syncthing_request,
            sync_sidecar::sync_sidecar_status,
            sync_sidecar::sync_sidecar_start,
            sync_sidecar::sync_sidecar_stop,
            sync_sidecar::sync_sidecar_adopt,
            sync_conflicts::sync_conflicts,
            sync_conflicts::sync_resolve_conflict
        ])
        .build(tauri::generate_context!())
        .expect("error while building BridgeDeck")
        .run(|app, event| match event {
            // Clicking the Dock icon brings back a window hidden by closing it.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => tray::show_main(app),
            // Files opened with BridgeDeck in Finder, or dropped on its Dock icon.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                send_to::deliver(app, urls.iter().filter_map(|url| url.to_file_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect());
            }
            tauri::RunEvent::Exit => {
                activity::info("app", "BridgeDeck closed.");
                errorlog::closed();
                mimir_host::stop();
                sync_sidecar::shutdown(app);
            }
            _ => {}
        });
}
