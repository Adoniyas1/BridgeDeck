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
    /// A ready-built release from GitHub (no rebuild): the Mac app or the Windows installer.
    Release,
}

impl UpgradeMode {
    fn arg(&self) -> &'static str {
        match self { UpgradeMode::Git => "git", UpgradeMode::Source => "source", UpgradeMode::Release => "release" }
    }
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
    /// The end of the update's log, while it runs or after it failed.
    pub log_tail: Vec<String>,
    /// macOS only: whether builds are signed with the local certificate ("ready"), so permissions
    /// stay after updates, or not yet ("missing"). Not set on other systems.
    pub signing: Option<&'static str>,
}

/// The free local code-signing certificate (scripts/mac-signing.sh); the update scripts sign with it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const SIGNING_IDENTITY: &str = "BridgeDeck Local Signing";

#[cfg(target_os = "macos")]
fn signing_ready() -> bool {
    Command::new("/usr/bin/security")
        .args(["find-identity", "-v", "-p", "codesigning"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{SIGNING_IDENTITY}\"")))
        .unwrap_or(false)
}

fn signing_state() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    return Some(if signing_ready() { "ready" } else { "missing" });
    #[cfg(not(target_os = "macos"))]
    None
}

/// Creates the local signing certificate (macOS asks for the password once to trust it), so that
/// from the next update on, Screen Recording, Accessibility and the other permissions stay granted.
/// Runs the same script as `npm run mac:signing`, built into the app.
pub fn setup_signing() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if signing_ready() {
            return Ok("Already set up.".into());
        }
        let out = Command::new("/bin/bash")
            .arg("-c")
            .arg(include_str!("../../scripts/mac-signing.sh"))
            .output()
            .map_err(|e| e.to_string())?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        if out.status.success() && signing_ready() {
            Ok(text.trim().to_string())
        } else {
            Err(format!("Couldn't set it up: {}", text.trim().lines().last().unwrap_or("the script failed")))
        }
    }
    #[cfg(not(target_os = "macos"))]
    Err("Only needed on a Mac".into())
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

fn read_status_file(app: &AppHandle) -> UpgradeStatus {
    status_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<UpgradeStatus>(raw.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_else(|| UpgradeStatus { state: "idle".into(), ..Default::default() })
}

/// The update's status. A run whose script is no longer alive, or that stopped reporting for 45
/// minutes, is reported (and recorded) as failed, so the UI never waits on a dead update.
pub fn read_status(app: &AppHandle) -> UpgradeStatus {
    let mut status = read_status_file(app);
    if status.state != "running" {
        return status;
    }
    let pid = upgrade_dir(app).ok().and_then(|d| fs::read_to_string(d.join(PID_FILE)).ok()).and_then(|p| p.trim().parse::<u32>().ok());
    if let Some(reason) = stopped_reason(&status, pid, now_ms(), process_alive) {
        status.state = "failed".into();
        status.message = reason;
        status.updated_at = now_ms();
        let _ = write_status(app, &status);
    }
    status
}

const PID_FILE: &str = "script.pid";
const STALL_MS: u64 = 45 * 60_000;

/// Why a "running" update is really over, if it is: its script exited without saying how it went,
/// or nothing was reported for 45 minutes.
pub fn stopped_reason(status: &UpgradeStatus, pid: Option<u32>, now: u64, alive: impl Fn(u32) -> bool) -> Option<String> {
    if let Some(pid) = pid {
        // Give a just-started script a moment to write its first status.
        if now.saturating_sub(status.updated_at) > 10_000 && !alive(pid) {
            return Some(format!("The update stopped unexpectedly while {} (see the log below)", stage_words(&status.stage)));
        }
    }
    (now.saturating_sub(status.updated_at) > STALL_MS).then(|| format!("The update made no progress for 45 minutes while {}; it was given up", stage_words(&status.stage)))
}

fn stage_words(stage: &str) -> &'static str {
    match stage {
        "pull" => "getting the latest version",
        "unpack" => "unpacking the source",
        "deps" => "installing dependencies",
        "vendor" => "fetching LocalSend",
        "verify" => "checking the project",
        "build" => "building",
        "install" => "installing",
        _ => "starting",
    }
}

/// Whether a process is still running.
fn process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("tasklist");
        cmd.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]);
        hide_console(&mut cmd);
        cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\""))).unwrap_or(true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(true)
    }
}

/// The last lines of the update's log.
fn log_tail(app: &AppHandle, lines: usize) -> Vec<String> {
    let Ok(path) = status_path(app) else { return Vec::new() };
    let raw = fs::read(PathBuf::from(format!("{}.log", path.display()))).unwrap_or_default();
    let text = String::from_utf8_lossy(&raw).replace('\u{feff}', "").replace('\0', "");
    let all: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.is_empty()).collect();
    all[all.len().saturating_sub(lines)..].iter().map(|l| l.chars().take(400).collect()).collect()
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
        log_tail: Vec::new(),
        signing: signing_state(),
        status: read_status(app),
    }
    .with_log(app)
}

impl UpgradeInfo {
    fn with_log(mut self, app: &AppHandle) -> Self {
        if matches!(self.status.state.as_str(), "running" | "failed") {
            self.log_tail = log_tail(app, 25);
        }
        self
    }
}

pub fn is_running(app: &AppHandle) -> bool {
    // read_status turns a dead or stalled run into "failed", so one crash can't block updates forever.
    read_status(app).state == "running"
}

/// Checks a request can run here before asking the user to approve it.
pub fn preflight(mode: &UpgradeMode) -> Result<(), String> {
    if *mode == UpgradeMode::Release {
        if running_from_source() {
            return Err("This is a development build (npm run tauri dev); it updates from its source instead".into());
        }
        return Ok(());
    }
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
    if let Ok(work) = upgrade_dir(app) {
        let _ = fs::remove_file(work.join(PID_FILE));
    }
    write_status(app, &UpgradeStatus {
        state: "running".into(),
        stage: "starting".into(),
        message: "Starting".into(),
        mode: mode.arg().into(),
        requested_by: requested_by.into(),
        from_version: env!("CARGO_PKG_VERSION").into(),
        updated_at: now_ms(),
    })?;
    if mode == UpgradeMode::Release {
        // Download (network, so off the calling thread), check it, then install it.
        let app = app.clone();
        std::thread::spawn(move || {
            match download_release(&app).and_then(|file| launch_script(&app, &mode, Some(file), &dir)) {
                Ok(()) => {}
                Err(error) => set_stage(&app, "failed", "download", error),
            }
        });
        return Ok(());
    }
    if running_from_source() {
        update_in_place(app.clone(), mode, bundle, dir);
        return Ok(());
    }
    if mode == UpgradeMode::Git {
        // Bring the clone onto GitHub's main first (network, so off the calling thread); the
        // script's own `git pull` is then a no-op.
        let app = app.clone();
        std::thread::spawn(move || {
            set_stage(&app, "running", "pull", "Getting the latest version from GitHub".into());
            match prepare_git(&dir).and_then(|_| launch_script(&app, &mode, None, &dir)) {
                Ok(()) => {}
                Err(error) => set_stage(&app, "failed", "pull", error),
            }
        });
        return Ok(());
    }
    launch_script(app, &mode, bundle, &dir)
}

fn set_stage(app: &AppHandle, state: &str, stage: &str, message: String) {
    let mut current = read_status(app);
    current.state = state.into();
    current.stage = stage.into();
    current.message = message;
    current.updated_at = now_ms();
    let _ = write_status(app, &current);
}

/// The update script to run: the source's own (it may be newer, just pulled) when rebuilding from
/// source, the one built into this app when installing a release (no source needed).
fn copy_script(mode: &UpgradeMode, dir: &Path, name: &str, built_in: &str, to: &Path) -> Result<(), String> {
    let from_source = dir.join("scripts").join(name);
    if *mode != UpgradeMode::Release && from_source.exists() {
        return fs::copy(&from_source, to).map(|_| ()).map_err(|e| format!("self-update script: {e}"));
    }
    fs::write(to, built_in).map_err(|e| format!("self-update script: {e}"))
}

/// The detached rebuild-and-reinstall script (`scripts/self-update.*`).
fn launch_script(app: &AppHandle, mode: &UpgradeMode, bundle: Option<PathBuf>, dir: &Path) -> Result<(), String> {
    let dir = dir.to_path_buf();
    let work = upgrade_dir(app)?;
    let status_file = status_path(app)?;
    let mode_arg = mode.arg();
    let bundle_arg = bundle.map(|b| b.to_string_lossy().to_string()).unwrap_or_default();
    let app_path = current_app_path();

    // Run a copy of the script: `git pull` or unpacking may rewrite the original while it executes.
    #[cfg(target_os = "windows")]
    let child = {
        use std::os::windows::process::CommandExt;
        let script = work.join("self-update.ps1");
        copy_script(mode, &dir, "self-update.ps1", include_str!("../../scripts/self-update.ps1"), &script)?;
        Command::new("powershell.exe")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
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
        copy_script(mode, &dir, "self-update.sh", include_str!("../../scripts/self-update.sh"), &script)?;
        use std::os::unix::process::CommandExt;
        Command::new("/bin/bash")
            .arg(&script)
            .args([mode_arg, &bundle_arg])
            .arg(&status_file)
            .arg(&dir)
            .arg(&app_path)
            // Its own process group, with nothing tied to this app: macOS ends a quitting app's
            // process group, which would stop the update just as it installs the new version.
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
    };
    if let Ok(child) = &child {
        let _ = fs::write(work.join(PID_FILE), child.id().to_string());
    }
    child.map(|_| ()).map_err(|e| {
        let _ = write_status(app, &UpgradeStatus { state: "failed".into(), stage: "starting".into(), message: e.to_string(), updated_at: now_ms(), ..Default::default() });
        format!("Could not start the upgrade: {e}")
    })
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// This build runs from a git clone, so it can check and update itself.
    pub git: bool,
    /// Commits on GitHub that this clone doesn't have.
    pub behind: u32,
    /// What's compared against, e.g. `origin/main`.
    pub upstream: String,
    /// The newest of those commits' titles.
    pub latest: String,
    /// A newer ready-built release on GitHub, if there is one.
    pub release: Option<Release>,
    /// This build's version.
    pub version: String,
}

// ---- Ready-built releases (GitHub Releases, made by .github/workflows/release.yml) ----

/// Where releases are published when the clone's own remote can't tell.
const REPO: &str = "Adoniyas1/BridgeDeck";

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub name: String,
    pub notes: String,
    pub published: String,
    /// Whether it has a download for this computer.
    pub installable: bool,
}

/// "owner/repo" from a GitHub remote address (https or ssh).
pub fn repo_from_remote(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://github.com/").or_else(|| url.trim().strip_prefix("git@github.com:"))
        .or_else(|| url.trim().strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = rest.splitn(3, '/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (ok(owner) && ok(repo)).then(|| format!("{owner}/{repo}"))
}

fn repo() -> String {
    git_output(&source_dir(), &["remote", "get-url", "origin"]).ok().and_then(|u| repo_from_remote(&u)).unwrap_or_else(|| REPO.into())
}

/// The GitHub sign-in this computer already uses for `git pull` (the repository is private), from
/// git's own credential store; none when git has no saved sign-in for GitHub.
fn github_token() -> Option<String> {
    use std::io::Write;
    let mut cmd = Command::new(git_program());
    cmd.args(["credential", "fill"]).env("GIT_TERMINAL_PROMPT", "0").env("GCM_INTERACTIVE", "never")
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    child.stdin.take()?.write_all(b"protocol=https\nhost=github.com\n\n").ok()?;
    let out = child.wait_with_output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().find_map(|l| l.strip_prefix("password=").map(str::to_string)).filter(|t| !t.is_empty())
}

/// Whether version `a` is newer than `b` ("0.10.2" > "0.9.7"; a leading "v" is ignored).
pub fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.trim().trim_start_matches('v').split(['.', '-', '+']).take(3).map(|p| p.parse().unwrap_or(0)).collect() };
    parse(a) > parse(b)
}

/// This computer's download in a release: the Mac app or the Windows installer.
fn is_download_for_here(name: &str) -> bool {
    if cfg!(target_os = "macos") { name.ends_with(".app.tar.gz") } else if cfg!(windows) { name.ends_with("-setup.exe") } else { false }
}

fn github() -> Result<(reqwest::blocking::Client, Option<String>), String> {
    let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(600)).user_agent("BridgeDeck updater").build().map_err(|e| e.to_string())?;
    Ok((client, github_token()))
}

fn latest_release_json() -> Result<Option<serde_json::Value>, String> {
    let (client, token) = github()?;
    let mut request = client.get(format!("https://api.github.com/repos/{}/releases/latest", repo())).header("Accept", "application/vnd.github+json");
    if let Some(token) = &token {
        request = request.bearer_auth(token);
    }
    let response = request.send().map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        // No release yet (or, for a private repository, no saved GitHub sign-in to see it).
        return Ok(None);
    }
    let response = response.error_for_status().map_err(|e| format!("GitHub releases: {e}"))?;
    response.json().map(Some).map_err(|e| e.to_string())
}

pub fn release_from_json(json: &serde_json::Value) -> Release {
    Release {
        version: json["tag_name"].as_str().unwrap_or_default().trim_start_matches('v').to_string(),
        name: json["name"].as_str().unwrap_or_default().to_string(),
        notes: json["body"].as_str().unwrap_or_default().chars().take(2000).collect(),
        published: json["published_at"].as_str().unwrap_or_default().to_string(),
        installable: json["assets"].as_array().into_iter().flatten().any(|a| a["name"].as_str().is_some_and(is_download_for_here)),
    }
}

/// A release newer than this build, if GitHub has one.
pub fn check_release() -> Result<Option<Release>, String> {
    Ok(latest_release_json()?.map(|j| release_from_json(&j)).filter(|r| newer(&r.version, env!("CARGO_PKG_VERSION"))))
}

/// The SHA-256 listed for `file` in a `SHA256SUMS.txt` ("<hash>  <name>" per line).
pub fn checksum_for(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.trim().split_once(char::is_whitespace)?;
        (name.trim().trim_start_matches('*') == file && hash.len() == 64).then(|| hash.to_ascii_lowercase())
    })
}

/// Downloads this computer's file from the latest release and checks it against the release's
/// checksums. Returns where it was saved.
fn download_release(app: &AppHandle) -> Result<PathBuf, String> {
    set_stage(app, "running", "download", "Looking for the latest release".into());
    let json = latest_release_json()?.ok_or("There's no release on GitHub yet (or this computer has no GitHub sign-in saved for git)")?;
    let release = release_from_json(&json);
    let assets: Vec<&serde_json::Value> = json["assets"].as_array().into_iter().flatten().collect();
    let asset = assets.iter().find(|a| a["name"].as_str().is_some_and(is_download_for_here)).ok_or("The latest release has no download for this computer yet")?;
    let sums = assets.iter().find(|a| a["name"] == "SHA256SUMS.txt").ok_or("The latest release has no checksums")?;
    let (client, token) = github()?;
    let fetch = |asset: &serde_json::Value| -> Result<Vec<u8>, String> {
        let url = asset["url"].as_str().ok_or("A release file without an address")?;
        if !url.starts_with("https://api.github.com/") {
            return Err("Unexpected download address".into());
        }
        let mut request = client.get(url).header("Accept", "application/octet-stream");
        if let Some(token) = &token {
            request = request.bearer_auth(token);
        }
        request.send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes()).map(|b| b.to_vec()).map_err(|e| format!("Download failed: {e}"))
    };
    let name = asset["name"].as_str().unwrap_or_default().to_string();
    if name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("Unexpected file name in the release".into());
    }
    let expected = checksum_for(&String::from_utf8_lossy(&fetch(sums)?), &name).ok_or("The checksums don't list this computer's download")?;
    set_stage(app, "running", "download", format!("Downloading v{}", release.version));
    let bytes = fetch(asset)?;
    let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        return Err("The download didn't match its checksum, so it wasn't installed".into());
    }
    let folder = upgrade_dir(app)?.join("release");
    let _ = fs::remove_dir_all(&folder);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file = folder.join(&name);
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    set_stage(app, "running", "install", format!("Installing v{}", release.version));
    Ok(file)
}

fn git_output(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(git_program());
    cmd.arg("-C").arg(dir).args(args).env("GIT_TERMINAL_PROMPT", "0");
    hide_console(&mut cmd);
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// "main @ 1a2b3c4" (plus "with local edits") for diagnostics; None outside a git clone.
pub fn git_summary() -> Option<String> {
    let dir = source_dir();
    if !git_ready(&dir) {
        return None;
    }
    let branch = git_output(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let commit = git_output(&dir, &["rev-parse", "--short", "HEAD"]).ok()?;
    let edited = git_output(&dir, &["status", "--porcelain", "--untracked-files=no"]).map(|s| !s.is_empty()).unwrap_or(false);
    Some(format!("{branch} @ {commit}{}", if edited { " with local edits" } else { "" }))
}

/// BridgeDeck's releases: every merged change lands here.
const MAIN: &str = "main";
/// Rewritten by npm / cargo on every install; local copies never hold anyone's work.
const REGENERATED: [&str; 3] = ["package-lock.json", "src-tauri/Cargo.lock", "mimir/package-lock.json"];

/// Puts the clone on GitHub's `main`, so an update can't be blocked by how it was left:
/// regenerated lock files lose their local changes, any other edits (and new files) are stashed,
/// a different branch (say, an old pull request branch) is left as it was while `main` is checked
/// out, and `main` fast-forwards. Ok(true): edits were stashed.
pub fn prepare_git(dir: &Path) -> Result<bool, String> {
    git_output(dir, &["fetch", "--quiet", "origin", MAIN]).map_err(|e| format!("Could not reach GitHub: {e}"))?;
    let target = format!("origin/{MAIN}");
    for file in REGENERATED {
        if dir.join(file).exists() && git_output(dir, &["diff", "--quiet", "--", file]).is_err() {
            let _ = git_output(dir, &["checkout", "--", file]);
        }
    }
    let dirty = !git_output(dir, &["status", "--porcelain"])?.is_empty();
    if dirty {
        let message = format!("BridgeDeck update {}", now_ms());
        // Stashing makes a commit; a clone without a git identity would refuse it.
        git_output(dir, &["-c", "user.name=BridgeDeck", "-c", "user.email=bridgedeck@localhost", "stash", "push", "--include-untracked", "-m", &message])
            .map_err(|e| format!("Couldn't set your local edits aside: {e}"))?;
    }
    let branch = git_output(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    if branch != MAIN {
        let has_main = git_output(dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{MAIN}")]).is_ok();
        if has_main {
            git_output(dir, &["checkout", MAIN]).map_err(|e| format!("Couldn't switch to {MAIN}: {e}"))?;
        } else {
            git_output(dir, &["checkout", "-b", MAIN, "--track", &target]).map_err(|e| format!("Couldn't switch to {MAIN}: {e}"))?;
        }
    }
    git_output(dir, &["merge", "--ff-only", &target]).map_err(|_| {
        format!("This computer's {MAIN} has commits that aren't on GitHub, so it can't simply be updated. Push or remove them (git log origin/{MAIN}..{MAIN}), then try again.")
    })?;
    Ok(dirty)
}

/// Fetches from GitHub and counts the commits this clone is missing from `main` (what "Update" gets).
pub fn check_for_update() -> Result<UpdateCheck, String> {
    let dir = source_dir();
    let version = env!("CARGO_PKG_VERSION").to_string();
    // A release is looked for either way; a failure to reach GitHub only shows when git can't either.
    let release = check_release();
    if !git_ready(&dir) {
        return Ok(UpdateCheck { release: release?, version, ..UpdateCheck::default() });
    }
    let release = release.unwrap_or(None);
    git_output(&dir, &["fetch", "--quiet", "origin", MAIN]).map_err(|e| format!("Could not reach GitHub: {e}"))?;
    let upstream = format!("origin/{MAIN}");
    let behind = git_output(&dir, &["rev-list", "--count", &format!("HEAD..{upstream}")])?.parse().unwrap_or(0);
    let latest = if behind > 0 { git_output(&dir, &["log", "-1", "--format=%s", &upstream]).unwrap_or_default() } else { String::new() };
    Ok(UpdateCheck { git: true, behind, upstream, latest, release, version })
}

/// Started by `npm run tauri dev` (a debug build): the dev server watches the source and rebuilds and
/// restarts BridgeDeck when it changes, so there is no installed app to replace.
fn running_from_source() -> bool {
    cfg!(debug_assertions)
}

/// Updates the source the dev server is watching: pull (or unpack), then `npm install` if the
/// dependencies changed. The dev server rebuilds and restarts BridgeDeck by itself.
fn update_in_place(app: AppHandle, mode: UpgradeMode, bundle: Option<PathBuf>, dir: PathBuf) {
    std::thread::spawn(move || {
        let status = |state: &str, stage: &str, message: String| set_stage(&app, state, stage, message);
        let lock = |dir: &Path| fs::read(dir.join("package-lock.json")).ok();
        let result = (|| -> Result<String, String> {
            let before = lock(&dir);
            let mut note = String::new();
            match mode {
                UpgradeMode::Git => {
                    status("running", "pull", "Getting the latest version from GitHub".into());
                    if prepare_git(&dir)? {
                        note = " Your own edits were set aside with git stash (git stash pop brings them back).".into();
                    }
                }
                UpgradeMode::Release => return Err("A development build updates from its source".into()),
                UpgradeMode::Source => {
                    status("running", "unpack", "Unpacking the source sent by the other computer".into());
                    let bundle = bundle.ok_or("The source bundle is missing")?;
                    let mut cmd = Command::new("tar");
                    cmd.arg("-xzf").arg(&bundle).arg("-C").arg(&dir);
                    hide_console(&mut cmd);
                    let output = cmd.output().map_err(|e| e.to_string())?;
                    if !output.status.success() {
                        return Err(format!("Unpacking failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
                    }
                }
            }
            if lock(&dir) != before {
                status("running", "deps", "Installing dependencies".into());
                let mut cmd = Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" });
                cmd.arg("install").current_dir(&dir);
                hide_console(&mut cmd);
                let output = cmd.output().map_err(|e| format!("npm install: {e}"))?;
                if !output.status.success() {
                    return Err(format!("npm install failed: {}", String::from_utf8_lossy(&output.stderr).lines().last().unwrap_or("")));
                }
            }
            Ok(format!("Updated. BridgeDeck rebuilds and restarts by itself in a minute or two.{note}"))
        })();
        match result {
            Ok(message) => status("succeeded", "done", message),
            Err(error) => status("failed", "update", error),
        }
    });
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
    // node_modules and build output anywhere (mimir/ has its own), plus vendored trees and git.
    for pattern in ["./vendor", "node_modules", "./src-tauri/target", "./src-tauri/gen", "./dist", "./mimir/dist", "./.git", "./release", ".DS_Store", "*.tsbuildinfo", "*.zip", "*.dmg"] {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releases_reading_and_versions() {
        assert_eq!(repo_from_remote("https://github.com/Adoniyas1/BridgeDeck.git").as_deref(), Some("Adoniyas1/BridgeDeck"));
        assert_eq!(repo_from_remote("git@github.com:Adoniyas1/BridgeDeck.git").as_deref(), Some("Adoniyas1/BridgeDeck"));
        assert_eq!(repo_from_remote("https://gitlab.com/a/b"), None);
        assert!(newer("0.10.0", "0.9.9") && newer("v1.0.0", "0.99.0") && !newer("0.9.1", "0.9.1") && !newer("0.9.0", "0.9.1"));
        let sums = format!("{}  BridgeDeck_0.9.2_universal.app.tar.gz\n{} *BridgeDeck_0.9.2_x64-setup.exe\n", "a".repeat(64), "B".repeat(64));
        assert_eq!(checksum_for(&sums, "BridgeDeck_0.9.2_universal.app.tar.gz"), Some("a".repeat(64)));
        assert_eq!(checksum_for(&sums, "BridgeDeck_0.9.2_x64-setup.exe"), Some("b".repeat(64)));
        assert_eq!(checksum_for(&sums, "other.dmg"), None);
        let json = serde_json::json!({ "tag_name": "v0.9.2", "name": "BridgeDeck 0.9.2", "body": "Notes", "published_at": "2026-10-06T10:00:00Z",
            "assets": [{ "name": "BridgeDeck_0.9.2_universal.app.tar.gz" }, { "name": "BridgeDeck_0.9.2_x64-setup.exe" }, { "name": "SHA256SUMS.txt" }] });
        let release = release_from_json(&json);
        assert_eq!((release.version.as_str(), release.notes.as_str()), ("0.9.2", "Notes"));
        assert_eq!(release.installable, cfg!(any(target_os = "macos", windows)));
    }

    #[test]
    fn a_dead_or_stalled_update_is_reported_as_failed() {
        let status = |stage: &str, at: u64| UpgradeStatus { state: "running".into(), stage: stage.into(), updated_at: at, ..Default::default() };
        let now = 10_000_000;
        // Script alive and reporting: still running.
        assert_eq!(stopped_reason(&status("build", now - 60_000), Some(42), now, |_| true), None);
        // Script gone without saying how it went.
        assert_eq!(stopped_reason(&status("install", now - 60_000), Some(42), now, |_| false).unwrap(), "The update stopped unexpectedly while installing (see the log below)");
        // Just started: give it a moment.
        assert_eq!(stopped_reason(&status("starting", now - 2_000), Some(42), now, |_| false), None);
        // No script yet (getting the latest version first), but silent for 45 minutes.
        assert_eq!(stopped_reason(&status("pull", now - 60_000), None, now, |_| false), None);
        assert!(stopped_reason(&status("pull", now - STALL_MS - 1), None, now, |_| true).unwrap().contains("no progress for 45 minutes while getting the latest version"));
    }

    #[test]
    fn this_process_is_alive_and_a_finished_one_is_not() {
        assert!(process_alive(std::process::id()));
        let mut child = Command::new(if cfg!(windows) { "cmd" } else { "true" }).args(if cfg!(windows) { vec!["/C", "exit"] } else { vec![] }).spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!process_alive(pid));
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"]).args(args).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn commit(dir: &Path, file: &str, text: &str, message: &str) {
        fs::write(dir.join(file), text).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", message]);
    }

    /// A GitHub stand-in, a copy that publishes to it, and this computer's clone.
    fn repos() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("bd-upgrade-{}", uuid::Uuid::new_v4()));
        let (origin, publisher, local) = (root.join("origin.git"), root.join("publisher"), root.join("local"));
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
        git(&root, &["clone", "-q", origin.to_str().unwrap(), publisher.to_str().unwrap()]);
        commit(&publisher, "package-lock.json", "{\"v\":1}", "first");
        commit(&publisher, "app.txt", "v1", "app v1");
        git(&publisher, &["push", "-q", "origin", "HEAD:main"]);
        git(&root, &["clone", "-q", origin.to_str().unwrap(), local.to_str().unwrap()]);
        (origin, publisher, local)
    }

    #[test]
    fn an_update_gets_main_whatever_state_the_clone_was_left_in() {
        let (_origin, publisher, local) = repos();
        // This computer: on an old pull-request branch with its own commit, npm rewrote the lock
        // file, a tracked file was edited and a new file added.
        git(&local, &["checkout", "-q", "-b", "claude/old-branch"]);
        commit(&local, "app.txt", "old branch version", "old work");
        fs::write(local.join("package-lock.json"), "{\"v\":\"npm rewrote me\"}").unwrap();
        fs::write(local.join("app.txt"), "my edit").unwrap();
        fs::write(local.join("notes.txt"), "mine").unwrap();
        // Meanwhile main moved on.
        commit(&publisher, "app.txt", "v2", "app v2");
        git(&publisher, &["push", "-q", "origin", "HEAD:main"]);

        assert!(prepare_git(&local).unwrap(), "the edits were stashed");
        assert_eq!(git(&local, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert_eq!(fs::read_to_string(local.join("app.txt")).unwrap(), "v2");
        assert_eq!(fs::read_to_string(local.join("package-lock.json")).unwrap(), "{\"v\":1}");
        assert!(!local.join("notes.txt").exists());
        // Nothing was lost: the old branch is intact and the edits are in the stash.
        assert_eq!(git(&local, &["log", "-1", "--format=%s", "claude/old-branch"]), "old work");
        assert!(git(&local, &["stash", "list"]).contains("BridgeDeck update"));

        // Already current: nothing to stash, still fine.
        assert!(!prepare_git(&local).unwrap());
    }

    #[test]
    fn local_commits_on_main_stop_the_update_with_an_explanation() {
        let (_origin, publisher, local) = repos();
        commit(&local, "mine.txt", "local only", "my commit on main");
        commit(&publisher, "app.txt", "v2", "app v2");
        git(&publisher, &["push", "-q", "origin", "HEAD:main"]);
        let error = prepare_git(&local).unwrap_err();
        assert!(error.contains("commits that aren't on GitHub"), "{error}");
    }
}
