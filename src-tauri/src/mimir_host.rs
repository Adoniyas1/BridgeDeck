//! Mimir (the self-editing assistant in `mimir/`) runs as a Node process that BridgeDeck owns: it is
//! installed and built on first use, started with BridgeDeck, restarted when it asks to (exit 75,
//! after a self-edit) or crashes, and stopped when BridgeDeck quits. Its UI is the Mimir tab, an
//! iframe on the page Mimir serves on 127.0.0.1 with a token only BridgeDeck knows.
//!
//! Mimir reports on stdout (see mimir/src/main/server.ts):
//!   MIMIR_LISTENING {"port":…,"token":…}   MIMIR_HEALTHY   MIMIR_NOTIFY {"title":…,"body":…}

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

const RELAUNCH_EXIT_CODE: i32 = 75;
const LOG_LINES: usize = 200;
/// Crashes within this window count towards giving up.
const CRASH_WINDOW: Duration = Duration::from_secs(300);
const MAX_CRASHES: usize = 5;
pub const VOICE_SHORTCUT: &str = "CommandOrControl+Shift+Space";

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Not started this session.
    Stopped,
    /// Installing packages or building.
    Setup,
    Starting,
    Running,
    /// Gave up (no Node, a failed build, or crashing over and over).
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    pub detail: String,
    /// The page to show in the tab while running.
    pub url: Option<String>,
    pub log: Vec<String>,
    /// mimir/ exists in this BridgeDeck's source folder.
    pub available: bool,
}

struct Host {
    phase: Phase,
    detail: String,
    url: Option<String>,
    log: VecDeque<String>,
    child: Option<Child>,
    /// Closing it tells Mimir that BridgeDeck is gone (it exits when its stdin ends).
    stdin: Option<ChildStdin>,
    stopping: bool,
    crashes: Vec<Instant>,
    token: String,
    /// What Mimir shows BridgeDeck's local API to use its toolbox (`bridgelink::mimir_api`).
    api_token: String,
    /// Bumped on every start, so a stale exit can't touch the next run.
    generation: u64,
}

static HOST: Mutex<Host> = Mutex::new(Host {
    phase: Phase::Stopped,
    detail: String::new(),
    url: None,
    log: VecDeque::new(),
    child: None,
    stdin: None,
    stopping: false,
    crashes: Vec::new(),
    token: String::new(),
    api_token: String::new(),
    generation: 0,
});

fn host() -> std::sync::MutexGuard<'static, Host> {
    HOST.lock().unwrap_or_else(|e| e.into_inner())
}

/// The token Mimir's toolbox requests must carry; empty until Mimir has been started.
pub fn api_token() -> String {
    host().api_token.clone()
}

fn mimir_dir() -> PathBuf {
    crate::upgrade::source_dir().join("mimir")
}

fn log_line(host: &mut Host, line: String) {
    if host.log.len() == LOG_LINES {
        host.log.pop_front();
    }
    host.log.push_back(line);
}

fn set_phase(phase: Phase, detail: impl Into<String>) {
    let mut host = host();
    host.phase = phase;
    host.detail = detail.into();
    if phase != Phase::Running {
        host.url = None;
    }
}

pub fn status() -> Status {
    let host = host();
    Status {
        phase: host.phase,
        detail: host.detail.clone(),
        url: host.url.clone(),
        log: host.log.iter().rev().take(30).rev().cloned().collect(),
        available: mimir_dir().join("package.json").exists(),
    }
}

/// A line Mimir printed, as BridgeDeck acts on it.
#[derive(Debug, PartialEq)]
enum Report {
    Listening { port: u16, token: String },
    Healthy,
    Notify { title: String, body: String },
    Other,
}

#[derive(Deserialize)]
struct ListeningLine {
    port: u16,
    token: String,
}

#[derive(Deserialize)]
struct NotifyLine {
    title: String,
    body: String,
}

fn parse_report(line: &str) -> Report {
    if let Some(rest) = line.strip_prefix("MIMIR_LISTENING ") {
        if let Ok(l) = serde_json::from_str::<ListeningLine>(rest) {
            return Report::Listening { port: l.port, token: l.token };
        }
    } else if line.trim() == "MIMIR_HEALTHY" {
        return Report::Healthy;
    } else if let Some(rest) = line.strip_prefix("MIMIR_NOTIFY ") {
        if let Ok(n) = serde_json::from_str::<NotifyLine>(rest) {
            return Report::Notify { title: n.title, body: n.body };
        }
    }
    Report::Other
}

/// `node` and `npm`, also where GUI apps don't get the shell's PATH (Homebrew, nvm, Volta, the
/// Windows installer's folder).
fn find_program(name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) { if name == "npm" { "npm.cmd".to_string() } else { format!("{name}.exe") } } else { name.to_string() };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from) {
        dirs.push(home.join(".volta").join("bin"));
        if let Ok(versions) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
            let mut found: Vec<PathBuf> = versions.filter_map(|e| e.ok()).map(|e| e.path().join("bin")).collect();
            found.sort();
            dirs.extend(found.into_iter().rev());
        }
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", r"C:\Program Files\nodejs"].map(PathBuf::from));
    dirs.into_iter().map(|d| d.join(&file)).find(|p| p.is_file())
}

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// The newest modification time of the files a build reads.
fn newest_source(dir: &Path) -> Option<SystemTime> {
    ["src", "scripts", "package.json", "vite.config.ts", "tsconfig.main.json", "tsconfig.renderer.json"]
        .iter()
        .flat_map(|p| walkdir::WalkDir::new(dir.join(p)).into_iter().filter_map(Result::ok))
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
        .max()
}

/// Whether packages need (re)installing and the build is out of date.
fn needs(dir: &Path) -> (bool, bool) {
    let installed = modified(&dir.join("node_modules").join(".package-lock.json"));
    let install = match (installed, modified(&dir.join("package-lock.json"))) {
        (Some(done), Some(lock)) => lock > done,
        _ => true,
    };
    let built = modified(&dir.join("dist").join("main").join("server.js"));
    let build = install || match (built, newest_source(dir)) {
        (Some(done), Some(source)) => source > done,
        _ => true,
    };
    (install, build)
}

/// Runs an npm step in mimir/, keeping its output in the log.
fn npm(npm: &Path, dir: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new(npm);
    cmd.args(args).current_dir(dir).stdin(Stdio::null());
    hide_console(&mut cmd);
    let output = cmd.output().map_err(|e| format!("npm {}: {e}", args.join(" ")))?;
    let mut host = host();
    for line in String::from_utf8_lossy(&output.stdout).lines().chain(String::from_utf8_lossy(&output.stderr).lines()).filter(|l| !l.trim().is_empty()) {
        log_line(&mut host, line.to_string());
    }
    if output.status.success() { Ok(()) } else { Err(format!("npm {} failed (see the log below)", args.join(" "))) }
}

/// Installs and builds if needed, then starts Mimir. Runs on a background thread.
fn setup_and_spawn(app: AppHandle) -> Result<(), String> {
    let dir = mimir_dir();
    if !dir.join("package.json").exists() {
        return Err(format!("Mimir isn't in this BridgeDeck's source folder ({})", dir.display()));
    }
    let node = find_program("node").ok_or("Node.js isn't installed (or BridgeDeck can't find it). Install it from nodejs.org, then press Start.")?;
    let (install, build) = needs(&dir);
    if install || build {
        let npm_path = find_program("npm").ok_or("npm isn't installed next to Node.js")?;
        if install {
            set_phase(Phase::Setup, "Installing Mimir's packages (the first time takes a few minutes)");
            if npm(&npm_path, &dir, &["ci", "--no-audit", "--no-fund"]).is_err() {
                npm(&npm_path, &dir, &["install", "--no-audit", "--no-fund"])?;
            }
        }
        set_phase(Phase::Setup, "Building Mimir");
        npm(&npm_path, &dir, &["run", "build"])?;
    }
    spawn(&app, &node, &dir)
}

fn api_port(app: &AppHandle) -> u16 {
    use tauri::Manager;
    crate::bridgelink::bridgelink_status(app.state::<crate::bridgelink::BridgeLinkManager>()).map(|s| s.api_port).unwrap_or(crate::bridgelink::DEFAULT_API_PORT)
}

fn spawn(app: &AppHandle, node: &Path, dir: &Path) -> Result<(), String> {
    let (token, api_token, generation) = {
        let mut host = host();
        if host.child.is_some() {
            return Ok(());
        }
        if host.token.is_empty() {
            host.token = uuid::Uuid::new_v4().simple().to_string();
        }
        if host.api_token.is_empty() {
            host.api_token = uuid::Uuid::new_v4().simple().to_string();
        }
        host.generation += 1;
        host.stopping = false;
        (host.token.clone(), host.api_token.clone(), host.generation)
    };
    set_phase(Phase::Starting, "Starting Mimir");
    // Mimir's Projects folder is BridgeDeck's synced one, so both see the same project files.
    let projects = crate::projects::root_for(&crate::shared_folder(app));
    let _ = std::fs::create_dir_all(&projects);
    let mut cmd = Command::new(node);
    cmd.arg("server-entry.mjs")
        .current_dir(dir)
        .env("MIMIR_TOKEN", &token)
        .env("MIMIR_EXIT_WITH_STDIN", "1")
        // Mimir's BridgeDeck tools (notes, calendar, Messages, files…) call back here.
        .env("BRIDGEDECK_API", format!("http://127.0.0.1:{}", api_port(app)))
        .env("BRIDGEDECK_TOKEN", &api_token)
        .env("MIMIR_PROJECTS_ROOT", &projects)
        // Skill packs chosen in Settings (skill_packs.rs).
        .env("MIMIR_SKILL_PACKS", crate::skill_packs::packs_dir(app).unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start Mimir: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut host = host();
        host.stdin = child.stdin.take();
        host.child = Some(child);
    }
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log_line(&mut host(), line);
            }
        });
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                handle_line(&app, generation, line);
            }
        }
        // Stdout closed: the process ended (or is about to).
        watch_exit(app, generation);
    });
    Ok(())
}

fn handle_line(app: &AppHandle, generation: u64, line: String) {
    match parse_report(&line) {
        Report::Listening { port, token } => {
            let mut host = host();
            if host.generation == generation {
                host.url = Some(format!("http://127.0.0.1:{port}/?token={token}"));
                host.phase = Phase::Running;
                host.detail = "Running".into();
            }
            drop(host);
            voice_shortcut(app, true);
        }
        Report::Healthy => {}
        Report::Notify { title, body } => {
            use tauri_plugin_notification::NotificationExt;
            let _ = app.notification().builder().title(title).body(body).show();
        }
        Report::Other => log_line(&mut host(), line),
    }
}

fn watch_exit(app: AppHandle, generation: u64) {
    let (code, stopping) = {
        let mut host = host();
        if host.generation != generation {
            return;
        }
        let code = host.child.take().and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
        host.stdin = None;
        (code, host.stopping)
    };
    voice_shortcut(&app, false);
    if stopping {
        set_phase(Phase::Stopped, "Stopped");
        return;
    }
    if code == Some(RELAUNCH_EXIT_CODE) {
        log_line(&mut host(), "[bridgedeck] Mimir asked to restart into its new build".into());
    } else {
        let too_many = {
            let mut host = host();
            let now = Instant::now();
            host.crashes.retain(|t| now.duration_since(*t) < CRASH_WINDOW);
            host.crashes.push(now);
            log_line(&mut host, format!("[bridgedeck] Mimir stopped unexpectedly (exit {code:?})"));
            host.crashes.len() >= MAX_CRASHES
        };
        if too_many {
            set_phase(Phase::Failed, "Mimir keeps stopping. See the log, then press Start to try again.");
            return;
        }
        set_phase(Phase::Starting, "Mimir stopped; starting it again");
        std::thread::sleep(Duration::from_secs(2));
    }
    start(app);
}

/// The voice hotkey belongs to Mimir while it runs: it shows BridgeDeck on the Mimir tab and
/// starts listening.
fn voice_shortcut(app: &AppHandle, on: bool) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let shortcuts = app.global_shortcut();
    if on {
        if !shortcuts.is_registered(VOICE_SHORTCUT) {
            let _ = shortcuts.on_shortcut(VOICE_SHORTCUT, |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    crate::tray::show_main(app);
                    let _ = app.emit("mimir-voice-hotkey", ());
                }
            });
        }
    } else {
        let _ = shortcuts.unregister(VOICE_SHORTCUT);
    }
}

/// Starts Mimir in the background (installing and building first when needed).
pub fn start(app: AppHandle) {
    {
        let mut host = host();
        if host.child.is_some() || matches!(host.phase, Phase::Setup) {
            return;
        }
        host.phase = Phase::Starting;
        host.detail = "Starting Mimir".into();
    }
    std::thread::spawn(move || {
        if let Err(error) = setup_and_spawn(app) {
            log_line(&mut host(), format!("[bridgedeck] {error}"));
            set_phase(Phase::Failed, error);
        }
    });
}

/// Stops Mimir (when BridgeDeck quits, or from the tab).
pub fn stop() {
    let mut host = host();
    host.stopping = true;
    host.stdin = None;
    if let Some(child) = host.child.as_mut() {
        let _ = child.kill();
    }
}

/// Where Mimir's control channel is, and its token, while it runs.
fn control_target() -> Option<(String, String)> {
    let host = host();
    let url = host.url.as_ref()?;
    let base = url.split("/?").next()?.to_string();
    Some((base, host.token.clone()))
}

/// One of Mimir's settings channels (CONTROL_CHANNELS in mimir/src/main/server.ts), for
/// BridgeDeck's own settings: its webview can't open Mimir's WebSocket, and the token stays here.
#[tauri::command]
pub async fn mimir_control(channel: String, args: Option<Vec<serde_json::Value>>) -> Result<serde_json::Value, String> {
    let (base, token) = control_target().ok_or("Mimir isn't running.")?;
    let reply: serde_json::Value = reqwest::Client::new()
        .post(format!("{base}/control"))
        .bearer_auth(token)
        // Asking Hugging Face or starting llama-swap can take a while.
        .timeout(std::time::Duration::from_secs(120))
        .json(&serde_json::json!({ "ch": channel, "args": args.unwrap_or_default() }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Mimir: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Mimir's answer wasn't readable: {e}"))?;
    control_reply(reply)
}

/// The same as `mimir_control`, for threads that aren't async (the phone page's server).
pub fn control_blocking(channel: &str, args: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    let (base, token) = control_target().ok_or("Mimir isn't running.")?;
    let reply: serde_json::Value = reqwest::blocking::Client::new()
        .post(format!("{base}/control"))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(20))
        .json(&serde_json::json!({ "ch": channel, "args": args }))
        .send()
        .map_err(|e| format!("Couldn't reach Mimir: {e}"))?
        .json()
        .map_err(|e| format!("Mimir's answer wasn't readable: {e}"))?;
    control_reply(reply)
}

fn control_reply(reply: serde_json::Value) -> Result<serde_json::Value, String> {
    if reply.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(reply.get("value").cloned().unwrap_or(serde_json::Value::Null))
    } else {
        Err(reply.get("error").and_then(|v| v.as_str()).unwrap_or("Mimir refused that.").to_string())
    }
}

#[tauri::command]
pub fn mimir_status() -> Status {
    status()
}

#[tauri::command]
pub fn mimir_start(app: AppHandle) -> Status {
    host().crashes.clear();
    start(app);
    status()
}

#[tauri::command]
pub fn mimir_stop() -> Status {
    stop();
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_are_read_from_stdout_lines() {
        assert_eq!(parse_report(r#"MIMIR_LISTENING {"port":4321,"token":"abc"}"#), Report::Listening { port: 4321, token: "abc".into() });
        assert_eq!(parse_report("MIMIR_HEALTHY"), Report::Healthy);
        assert_eq!(parse_report(r#"MIMIR_NOTIFY {"title":"Mimir — deadline","body":"Taxes"}"#), Report::Notify { title: "Mimir — deadline".into(), body: "Taxes".into() });
        assert_eq!(parse_report("MIMIR_LISTENING not json"), Report::Other);
        assert_eq!(parse_report("[mimir] hello"), Report::Other);
    }

    #[test]
    fn a_missing_build_or_install_is_noticed() {
        let dir = std::env::temp_dir().join(format!("bd-mimir-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("package-lock.json"), "{}").unwrap();
        std::fs::write(dir.join("src").join("a.ts"), "").unwrap();
        assert_eq!(needs(&dir), (true, true));
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("node_modules").join(".package-lock.json"), "{}").unwrap();
        std::fs::create_dir_all(dir.join("dist").join("main")).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("dist").join("main").join("server.js"), "").unwrap();
        assert_eq!(needs(&dir), (false, false));
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("src").join("a.ts"), "changed").unwrap();
        assert_eq!(needs(&dir), (false, true));
        let _ = std::fs::remove_dir_all(dir);
    }
}
