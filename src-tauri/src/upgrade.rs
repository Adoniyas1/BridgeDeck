//! One computer upgrading another (or itself): pull the latest `main` from GitHub, or rebuild from a
//! source bundle sent by the paired computer. The rebuild runs in a detached script
//! (`scripts/self-update.ps1` / `.sh`) because it replaces and restarts this app; progress is written to
//! a status file that `/upgrade/status` and the UI read.
//!
//! Remote requests arrive through BridgeLink (`POST /upgrade/request`), which requires the paired-peer
//! token and an Allow/Deny approval on this computer before anything runs.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpgradeMode {
    /// `git pull --ff-only` in this computer's clone.
    Git,
    /// A `bridgedeck-source-*.tar.gz` bundle received from the paired computer.
    Source,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpgradeStatus {
    /// idle | running | succeeded | failed
    pub state: String,
    pub stage: String,
    pub message: String,
    pub mode: String,
    pub requested_by: String,
    pub from_version: String,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeInfo {
    pub version: String,
    pub source_dir: String,
    /// The folder this build came from still has its source (needed for any upgrade).
    pub source_available: bool,
    /// That folder is a git clone and `git` runs (needed for GitHub mode).
    pub git_ready: bool,
    pub status: UpgradeStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBundle {
    pub path: String,
    pub file_name: String,
    pub sha256: String,
    pub bytes: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Source folder this binary was built from (baked in at compile time).
pub fn source_dir() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    dir.canonicalize().unwrap_or(dir)
}

fn upgrade_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("upgrade");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn status_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(upgrade_dir(app)?.join("status.json"))
}

pub fn read_status(app: &AppHandle) -> UpgradeStatus {
    status_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<UpgradeStatus>(raw.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_else(|| UpgradeStatus { state: "idle".into(), ..Default::default() })
}

fn write_status(app: &AppHandle, status: &UpgradeStatus) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(status).map_err(|e| e.to_string())?;
    fs::write(status_path(app)?, raw).map_err(|e| e.to_string())
}

fn git_ready(dir: &Path) -> bool {
    if !dir.join(".git").exists() {
        return false;
    }
    let mut cmd = Command::new(git_program());
    cmd.arg("--version");
    hide_console(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// `git` on PATH, or Git for Windows' default location (not on PATH for apps started before install).
fn git_program() -> String {
    #[cfg(target_os = "windows")]
    for candidate in [r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files (x86)\Git\cmd\git.exe"] {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "git".to_string()
}

#[cfg(target_os = "windows")]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(target_os = "windows"))]
fn hide_console(_cmd: &mut Command) {}

pub fn info(app: &AppHandle) -> UpgradeInfo {
    let dir = source_dir();
    UpgradeInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        source_available: dir.join("package.json").exists() && dir.join("src-tauri").exists(),
        git_ready: git_ready(&dir),
        source_dir: dir.to_string_lossy().to_string(),
        status: read_status(app),
    }
}

pub fn is_running(app: &AppHandle) -> bool {
    let status = read_status(app);
    // A run that stopped reporting for 45 minutes is treated as dead, so one crash can't block upgrades forever.
    status.state == "running" && now_ms().saturating_sub(status.updated_at) < 45 * 60_000
}

/// Checks a request can run here before asking the user to approve it.
pub fn preflight(mode: &UpgradeMode) -> Result<(), String> {
    let dir = source_dir();
    if !dir.join("package.json").exists() {
        return Err(format!("This computer's BridgeDeck source folder is missing ({})", dir.display()));
    }
    if *mode == UpgradeMode::Git && !git_ready(&dir) {
        return Err("This computer's BridgeDeck folder is not a git clone (or git isn't installed); use Send my source instead".into());
    }
    Ok(())
}

/// Starts the detached rebuild. `bundle` is required for `Source` and must already be verified.
pub fn start(app: &AppHandle, mode: UpgradeMode, bundle: Option<PathBuf>, requested_by: &str) -> Result<(), String> {
    preflight(&mode)?;
    if is_running(app) {
        return Err("An upgrade is already running on this computer".into());
    }
    let dir = source_dir();
    let work = upgrade_dir(app)?;
    let status_file = status_path(app)?;
    write_status(app, &UpgradeStatus {
        state: "running".into(),
        stage: "starting".into(),
        message: "Starting".into(),
        mode: if mode == UpgradeMode::Git { "git" } else { "source" }.into(),
        requested_by: requested_by.into(),
        from_version: env!("CARGO_PKG_VERSION").into(),
        updated_at: now_ms(),
    })?;
    let mode_arg = if mode == UpgradeMode::Git { "git" } else { "source" };
    let bundle_arg = bundle.map(|b| b.to_string_lossy().to_string()).unwrap_or_default();
    let app_path = current_app_path();

    // Run a copy of the script: `git pull` or unpacking may rewrite the original while it executes.
    #[cfg(target_os = "windows")]
    let child = {
        use std::os::windows::process::CommandExt;
        let script = work.join("self-update.ps1");
        fs::copy(dir.join("scripts").join("self-update.ps1"), &script).map_err(|e| format!("self-update script missing: {e}"))?;
        Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .args(["-Mode", mode_arg, "-Bundle", &bundle_arg, "-Status"]).arg(&status_file)
            .arg("-Src").arg(&dir)
            .arg("-AppPath").arg(&app_path)
            // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW: outlives this app.
            .creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000)
            .spawn()
    };
    #[cfg(not(target_os = "windows"))]
    let child = {
        let script = work.join("self-update.sh");
        fs::copy(dir.join("scripts").join("self-update.sh"), &script).map_err(|e| format!("self-update script missing: {e}"))?;
        Command::new("/bin/bash")
            .arg(&script)
            .args([mode_arg, &bundle_arg])
            .arg(&status_file)
            .arg(&dir)
            .arg(&app_path)
            .spawn()
    };
    child.map(|_| ()).map_err(|e| {
        let _ = write_status(app, &UpgradeStatus { state: "failed".into(), stage: "starting".into(), message: e.to_string(), updated_at: now_ms(), ..Default::default() });
        format!("Could not start the upgrade: {e}")
    })
}

/// Installed app to replace: the `.app` bundle on macOS, the executable elsewhere.
fn current_app_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    #[cfg(target_os = "macos")]
    if let Some(bundle) = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) {
        return bundle.to_path_buf();
    }
    exe
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Packs this computer's source (no dependencies, build output, vendor trees or `.git`) with the system `tar`.
pub fn create_source_bundle(app: &AppHandle) -> Result<SourceBundle, String> {
    let dir = source_dir();
    if !dir.join("package.json").exists() {
        return Err(format!("BridgeDeck source folder not found at {}", dir.display()));
    }
    let file_name = format!("bridgedeck-source-{}-{}.tar.gz", env!("CARGO_PKG_VERSION"), now_ms());
    let out = upgrade_dir(app)?.join(&file_name);
    let mut cmd = Command::new("tar");
    cmd.arg("-czf").arg(&out);
    for pattern in ["./vendor", "./node_modules", "./src-tauri/target", "./src-tauri/gen", "./dist", "./.git", "./release", "*.tsbuildinfo", "*.zip", "*.dmg"] {
        cmd.arg(format!("--exclude={pattern}"));
    }
    cmd.arg("-C").arg(&dir).arg(".");
    hide_console(&mut cmd);
    let output = cmd.output().map_err(|e| format!("Could not run tar: {e}"))?;
    if !output.status.success() {
        return Err(format!("tar failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let bytes = fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    Ok(SourceBundle { sha256: sha256_file(&out)?, path: out.to_string_lossy().to_string(), file_name, bytes })
}

/// Finds a received bundle in the LocalSend receive folder and checks its name and SHA-256.
pub fn locate_received_bundle(app: &AppHandle, file_name: &str, sha256: &str) -> Result<PathBuf, String> {
    let valid_name = file_name.starts_with("bridgedeck-source-")
        && file_name.ends_with(".tar.gz")
        && file_name.len() < 100
        && file_name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'));
    if !valid_name {
        return Err("Invalid source bundle name".into());
    }
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid source bundle checksum".into());
    }
    let path = crate::localsend_bridge::receive_destination(app).join(file_name);
    if !path.is_file() {
        return Err(format!("Source bundle {file_name} hasn't arrived in the receive folder"));
    }
    if sha256_file(&path)? != sha256.to_ascii_lowercase() {
        return Err("Source bundle checksum doesn't match; not using it".into());
    }
    // Keep a private copy so the file in the shared receive folder can't change mid-build.
    let copy = upgrade_dir(app)?.join(file_name);
    fs::copy(&path, &copy).map_err(|e| e.to_string())?;
    Ok(copy)
}
