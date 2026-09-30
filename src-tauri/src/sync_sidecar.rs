//! Syncthing as a hidden helper BridgeDeck owns (roadmap Phase 2, D3). BridgeDeck starts the bundled,
//! unmodified Syncthing binary with its own home folder, a loopback-only API on a free port and an API key
//! it generates, restarts it if it exits, and stops it on quit. The user never sees Syncthing's own UI.
//!
//! An existing Syncthing install can be adopted: its identity (device ID), settings and database are
//! copied into BridgeDeck's folder, so paired devices and shared folders keep working.

use serde::Serialize;
use std::{
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

const API_KEY_FILE: &str = "bridgedeck-apikey";
const ADOPTED_FILE: &str = "bridgedeck-adopted.json";
/// Restarts allowed within `RESTART_WINDOW` before BridgeDeck gives up and reports the failure.
const MAX_RESTARTS: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
struct State_ {
    child: Option<Child>,
    /// The user wants it running (BridgeDeck restarts it when it exits).
    wanted: bool,
    port: u16,
    api_key: String,
    home: Option<PathBuf>,
    executable: Option<PathBuf>,
    restarts: Vec<Instant>,
    detail: String,
}

#[derive(Clone, Default)]
pub struct SyncSidecar {
    inner: Arc<Mutex<State_>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    /// A Syncthing binary is bundled (or on PATH).
    pub available: bool,
    pub running: bool,
    pub base_url: String,
    pub api_key: String,
    pub home: String,
    pub detail: String,
    /// A separately installed Syncthing whose identity and folders can be moved into BridgeDeck.
    pub adoptable: Option<String>,
    pub adopted_from: Option<String>,
}

fn lock(sidecar: &SyncSidecar) -> Result<std::sync::MutexGuard<'_, State_>, String> {
    sidecar.inner.lock().map_err(|_| "Syncthing state lock poisoned".to_string())
}

fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("syncthing");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_or_create_api_key(home: &Path) -> Result<String, String> {
    let path = home.join(API_KEY_FILE);
    if let Ok(key) = fs::read_to_string(&path) {
        let key = key.trim().to_string();
        if key.len() >= 32 {
            return Ok(key);
        }
    }
    let key = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    fs::write(&path, &key).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(key)
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// The bundled Syncthing, else one on PATH.
fn find_executable(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = crate::bundled_runtime_path(app, "syncthing") {
        return Some(path);
    }
    let name = if cfg!(target_os = "windows") { "syncthing.exe" } else { "syncthing" };
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|dir| dir.join(name)).find(|p| p.is_file()))
}

/// Where a separately installed Syncthing keeps its identity and settings.
pub fn standalone_homes() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let mut candidates = Vec::new();
    if cfg!(target_os = "windows") {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Syncthing"));
        }
    } else if let Some(home) = home {
        if cfg!(target_os = "macos") {
            candidates.push(home.join("Library/Application Support/Syncthing"));
        }
        candidates.push(home.join(".local/state/syncthing"));
        candidates.push(home.join(".config/syncthing"));
    }
    candidates
}

fn is_syncthing_home(dir: &Path) -> bool {
    ["cert.pem", "key.pem", "config.xml"].iter().all(|f| dir.join(f).is_file())
}

fn adopted_from(home: &Path) -> Option<String> {
    let raw = fs::read_to_string(home.join(ADOPTED_FILE)).ok()?;
    serde_json::from_str::<serde_json::Value>(&raw).ok()?.get("from")?.as_str().map(str::to_string)
}

fn spawn_child(executable: &Path, home: &Path, port: u16, api_key: &str) -> Result<Child, String> {
    let log = fs::File::create(home.join("bridgedeck-syncthing.log")).map_err(|e| e.to_string())?;
    let mut command = Command::new(executable);
    command
        .arg("serve")
        .arg("--home")
        .arg(home)
        .arg("--gui-address")
        .arg(format!("http://127.0.0.1:{port}"))
        .arg("--gui-apikey")
        .arg(api_key)
        .args(["--no-browser", "--no-restart", "--no-upgrade"])
        // A fresh install would otherwise create ~/Sync ("Default Folder").
        .env("STNODEFAULTFOLDER", "1")
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.spawn().map_err(|e| format!("Could not start Syncthing: {e}"))
}

fn start_locked(app: &AppHandle, state: &mut State_) -> Result<(), String> {
    if let Some(child) = state.child.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(());
        }
    }
    let executable = state.executable.clone().or_else(|| find_executable(app)).ok_or("Syncthing isn't bundled with this build")?;
    let home = match state.home.clone() {
        Some(home) => home,
        None => home_dir(app)?,
    };
    let api_key = load_or_create_api_key(&home)?;
    let port = if state.port != 0 { state.port } else { free_port()? };
    state.child = Some(spawn_child(&executable, &home, port, &api_key)?);
    state.executable = Some(executable);
    state.home = Some(home);
    state.port = port;
    state.api_key = api_key;
    state.detail = "Running".into();
    Ok(())
}

/// Keeps Syncthing running while it is wanted: restarts it when it exits (Syncthing exits to apply
/// some settings), with a limit so a crash loop is reported instead of hidden.
fn spawn_supervisor(app: AppHandle, sidecar: SyncSidecar) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        let Ok(mut state) = sidecar.inner.lock() else { return };
        if !state.wanted {
            continue;
        }
        let exited = match state.child.as_mut() {
            Some(child) => child.try_wait().ok().flatten().is_some(),
            None => true,
        };
        if !exited {
            continue;
        }
        let now = Instant::now();
        state.restarts.retain(|at| now.duration_since(*at) < RESTART_WINDOW);
        if state.restarts.len() >= MAX_RESTARTS {
            state.wanted = false;
            state.detail = "Syncthing keeps stopping; see bridgedeck-syncthing.log in BridgeDeck's syncthing folder".into();
            continue;
        }
        state.restarts.push(now);
        state.child = None;
        if let Err(error) = start_locked(&app, &mut state) {
            state.detail = error;
        }
    });
}

fn status_locked(app: &AppHandle, state: &mut State_) -> SidecarStatus {
    let running = state.child.as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_none());
    let home = state.home.clone().or_else(|| home_dir(app).ok());
    let adopted = home.as_deref().and_then(adopted_from);
    // Offer adoption only before this Syncthing has an identity of its own that folders depend on.
    let adoptable = if adopted.is_none() {
        standalone_homes().into_iter().find(|dir| is_syncthing_home(dir) && Some(dir.as_path()) != home.as_deref()).map(|d| d.to_string_lossy().to_string())
    } else {
        None
    };
    SidecarStatus {
        available: state.executable.is_some() || find_executable(app).is_some(),
        running,
        base_url: if running { format!("http://127.0.0.1:{}", state.port) } else { String::new() },
        api_key: if running { state.api_key.clone() } else { String::new() },
        home: home.map(|h| h.to_string_lossy().to_string()).unwrap_or_default(),
        detail: if running { "Running".into() } else if state.detail.is_empty() { "Stopped".into() } else { state.detail.clone() },
        adoptable,
        adopted_from: adopted,
    }
}

/// Stops Syncthing: asks it to shut down cleanly, then kills it after 5 s.
fn stop_locked(state: &mut State_) {
    state.wanted = false;
    let Some(mut child) = state.child.take() else { return };
    if state.port != 0 {
        let _ = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .and_then(|c| c.post(format!("http://127.0.0.1:{}/rest/system/shutdown", state.port)).header("X-API-Key", &state.api_key).send());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Called when BridgeDeck quits.
pub fn shutdown(app: &AppHandle) {
    let sidecar = app.state::<SyncSidecar>().inner().clone();
    let Ok(mut state) = sidecar.inner.lock() else { return };
    stop_locked(&mut state);
}

pub fn init(app: &AppHandle) {
    spawn_supervisor(app.clone(), app.state::<SyncSidecar>().inner().clone());
}

#[tauri::command]
pub fn sync_sidecar_status(app: AppHandle, sidecar: State<'_, SyncSidecar>) -> Result<SidecarStatus, String> {
    let mut state = lock(&sidecar)?;
    Ok(status_locked(&app, &mut state))
}

#[tauri::command]
pub async fn sync_sidecar_start(app: AppHandle, sidecar: State<'_, SyncSidecar>) -> Result<SidecarStatus, String> {
    let sidecar = sidecar.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = lock(&sidecar)?;
        state.wanted = true;
        state.restarts.clear();
        start_locked(&app, &mut state)?;
        Ok(status_locked(&app, &mut state))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sync_sidecar_stop(app: AppHandle, sidecar: State<'_, SyncSidecar>) -> Result<SidecarStatus, String> {
    let sidecar = sidecar.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = lock(&sidecar)?;
        stop_locked(&mut state);
        state.detail = "Stopped".into();
        Ok(status_locked(&app, &mut state))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copies a Syncthing home's identity, settings and database into `to` (skipping lock files and logs).
pub fn copy_home(from: &Path, to: &Path) -> Result<(), String> {
    fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".lock") || name.starts_with("syncthing.log") || name.starts_with("bridgedeck-") || name.ends_with(".tmp") {
                continue;
            }
            let target = to.join(&name);
            if entry.file_type()?.is_dir() {
                copy_dir(&entry.path(), &target)?;
            } else {
                fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }
    copy_dir(from, to).map_err(|e| format!("Could not copy Syncthing's settings: {e}"))
}

/// Moves a separately installed Syncthing into BridgeDeck: stops it (through its own API when BridgeDeck
/// knows its address and key, otherwise the user must quit it first), copies its identity, settings and
/// database, and starts BridgeDeck's copy. The same device ID keeps paired devices and folders working.
#[tauri::command]
pub async fn sync_sidecar_adopt(app: AppHandle, source: String, base_url: String, api_key: String, sidecar: State<'_, SyncSidecar>) -> Result<SidecarStatus, String> {
    let sidecar = sidecar.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let from = PathBuf::from(&source);
        if !standalone_homes().contains(&from) || !is_syncthing_home(&from) {
            return Err("That isn't a Syncthing settings folder".to_string());
        }
        // Stop the standalone Syncthing so its database isn't copied mid-write.
        if !base_url.trim().is_empty() && !api_key.trim().is_empty() && crate::is_loopback_url(&base_url) {
            let url = format!("{}/rest/system/shutdown", base_url.trim_end_matches('/'));
            let _ = reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).build().and_then(|c| c.post(url).header("X-API-Key", api_key.trim()).send());
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        while from.join("syncthing.lock").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(300));
        }
        let mut state = lock(&sidecar)?;
        stop_locked(&mut state);
        let home = home_dir(&app)?;
        // Keep BridgeDeck's API key; take everything else from the adopted install.
        for name in ["cert.pem", "key.pem", "config.xml", "https-cert.pem", "https-key.pem"] {
            let _ = fs::remove_file(home.join(name));
        }
        let _ = fs::remove_dir_all(home.join("index-v2"));
        copy_home(&from, &home)?;
        let marker = serde_json::json!({ "from": source, "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) });
        fs::write(home.join(ADOPTED_FILE), marker.to_string()).map_err(|e| e.to_string())?;
        state.home = Some(home);
        state.wanted = true;
        state.restarts.clear();
        start_locked(&app, &mut state)?;
        Ok(status_locked(&app, &mut state))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copying_a_home_skips_locks_and_logs() {
        let root = std::env::temp_dir().join(format!("bd-st-{}", uuid::Uuid::new_v4()));
        let (from, to) = (root.join("from"), root.join("to"));
        fs::create_dir_all(from.join("index-v2")).unwrap();
        for name in ["cert.pem", "key.pem", "config.xml", "syncthing.lock", "syncthing.log", "index-v2/db"] {
            fs::write(from.join(name), name).unwrap();
        }
        copy_home(&from, &to).unwrap();
        assert!(is_syncthing_home(&to));
        assert!(to.join("index-v2/db").is_file());
        assert!(!to.join("syncthing.lock").exists());
        assert!(!to.join("syncthing.log").exists());
        let _ = fs::remove_dir_all(root);
    }

    /// Runs a real Syncthing when one has been built (`node scripts/build-syncthing.mjs`); skipped otherwise.
    #[test]
    fn starts_and_stops_a_real_syncthing() {
        let exe = Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime").join(if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" }).join("syncthing").join(if cfg!(target_os = "windows") { "syncthing.exe" } else { "syncthing" });
        if !exe.is_file() {
            eprintln!("skipped: no Syncthing at {}", exe.display());
            return;
        }
        let home = std::env::temp_dir().join(format!("bd-sidecar-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        let key = load_or_create_api_key(&home).unwrap();
        let port = free_port().unwrap();
        let mut state = State_ { child: Some(spawn_child(&exe, &home, port, &key).unwrap()), wanted: true, port, api_key: key.clone(), ..Default::default() };
        let client = reqwest::blocking::Client::new();
        let status = (0..60).find_map(|_| {
            thread::sleep(Duration::from_millis(500));
            client.get(format!("http://127.0.0.1:{port}/rest/system/status")).header("X-API-Key", &key).send().ok().filter(|r| r.status().is_success())
        });
        let body: serde_json::Value = status.expect("Syncthing answered").json().unwrap();
        assert!(body["myID"].as_str().is_some_and(|id| id.len() > 50));
        // No "Default Folder" is created.
        let folders: serde_json::Value = client.get(format!("http://127.0.0.1:{port}/rest/config/folders")).header("X-API-Key", &key).send().unwrap().json().unwrap();
        assert_eq!(folders.as_array().map(Vec::len), Some(0));
        // The API only answers with BridgeDeck's key.
        assert_eq!(client.get(format!("http://127.0.0.1:{port}/rest/system/status")).send().unwrap().status().as_u16(), 403);
        stop_locked(&mut state);
        assert!(state.child.is_none());
        assert!(client.get(format!("http://127.0.0.1:{port}/rest/system/status")).send().is_err());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn api_key_is_generated_once() {
        let dir = std::env::temp_dir().join(format!("bd-key-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let key = load_or_create_api_key(&dir).unwrap();
        assert_eq!(key.len(), 64);
        assert_eq!(load_or_create_api_key(&dir).unwrap(), key);
        let _ = fs::remove_dir_all(dir);
    }
}
