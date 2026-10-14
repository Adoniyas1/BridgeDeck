//! The safety stop: a watch on the computer that stops the local AI models (llama-server and
//! llama-swap) before they freeze it. Every few seconds it checks how much memory is left and, on
//! NVIDIA cards, graphics memory, and notices when the computer stopped responding for a while
//! (this thread didn't get to run). When memory runs out, or the computer froze while memory was
//! short, it stops the models, writes it in the activity log and tells the window. If that isn't
//! enough and the setting is on, it closes BridgeDeck as well. Settings live in
//! `<app data>/safety.json`; the tray menu and Settings can also stop the models straight away.

use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const TICK: Duration = Duration::from_secs(3);
/// This thread waking this late means the computer stopped responding (or was asleep).
const STALL: Duration = Duration::from_secs(20);
/// Never less free memory than this, whatever the percentage.
const FLOOR: u64 = 400 * 1024 * 1024;
/// After a stop, wait this long before stopping again.
const COOLDOWN: Duration = Duration::from_secs(60);
/// AI programs the safety stop may end (Mimir's model servers, never anything else).
const AI_PROGRAMS: &[&str] = &["llama-server", "llama-swap"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    /// Stop the models when this much of the RAM is in use (percent).
    pub memory_percent: u8,
    /// Also when the graphics card's memory is this full (percent; NVIDIA cards).
    pub vram_percent: u8,
    /// Close BridgeDeck too when stopping the models didn't free enough.
    pub close_app: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: true, memory_percent: 94, vram_percent: 98, close_app: false }
    }
}

impl Settings {
    fn clean(mut self) -> Self {
        self.memory_percent = self.memory_percent.clamp(70, 99);
        self.vram_percent = self.vram_percent.clamp(80, 100);
        self
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub settings: Settings,
    pub memory_used_percent: u8,
    pub vram_used_percent: Option<u8>,
    pub ai_running: bool,
    /// The last time it stepped in, and why.
    pub last_stop: Option<String>,
}

static FILE: OnceLock<PathBuf> = OnceLock::new();
static STATE: Mutex<Option<Status>> = Mutex::new(None);

fn load() -> Settings {
    FILE.get().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<Settings>(&t).ok()).unwrap_or_default().clean()
}

fn with_state<T>(f: impl FnOnce(&mut Status) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Status::default))
}

fn ai_pids(system: &mut sysinfo::System) -> Vec<sysinfo::Pid> {
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
        .processes()
        .iter()
        .filter(|(_, p)| {
            let name = p.name().to_string_lossy().to_ascii_lowercase();
            AI_PROGRAMS.iter().any(|a| name == *a || name == format!("{a}.exe"))
        })
        .map(|(pid, _)| *pid)
        .collect()
}

/// Ends the AI model servers. Returns how many programs it stopped.
pub fn stop_ai() -> usize {
    let mut system = sysinfo::System::new();
    let pids = ai_pids(&mut system);
    pids.iter().filter(|pid| system.process(**pid).is_some_and(|p| p.kill())).count()
}

/// Whether memory is short: past the setting's percentage, or under the floor.
pub fn memory_short(total: u64, available: u64, percent: u8) -> bool {
    total > 0 && (available < FLOOR || (total - available.min(total)) * 100 / total >= percent as u64)
}

fn step_in(app: &AppHandle, reason: &str, close_when_done: bool) {
    let stopped = stop_ai();
    let message = if stopped > 0 {
        format!("Safety stop: {reason}, so BridgeDeck stopped the AI models ({stopped} program{}). Start them again from Mimir when there's room.", if stopped == 1 { "" } else { "s" })
    } else {
        format!("Safety stop: {reason}.")
    };
    crate::activity::warn("safety", &message);
    with_state(|s| s.last_stop = Some(format!("{} — {reason}", crate::diagnostics::now_text())));
    let _ = app.emit("safety-stop", &message);
    if close_when_done {
        crate::activity::warn("safety", "Memory was still short after stopping the AI models: closing BridgeDeck (the setting is on).");
        std::thread::sleep(Duration::from_secs(2));
        app.exit(0);
    }
}

/// Starts the watch (once).
pub fn start(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = FILE.set(dir.join("safety.json"));
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("safety-stop".into()).spawn(move || {
        let mut system = sysinfo::System::new();
        let mut last = Instant::now();
        let mut short_for = 0u32;
        let mut stopped_at: Option<Instant> = None;
        let mut tick = 0u64;
        let mut vram: Option<u8> = None;
        loop {
            std::thread::sleep(TICK);
            tick += 1;
            let gap = last.elapsed();
            last = Instant::now();
            let settings = load();
            system.refresh_memory();
            let (total, available) = (system.total_memory(), system.available_memory());
            let used = ((total - available.min(total)) * 100).checked_div(total).unwrap_or(0) as u8;
            if tick % 5 == 1 {
                vram = crate::hardware::nvidia().iter().filter_map(|g| g.used_bytes.map(|u| (u * 100 / g.total_bytes.max(1)) as u8)).max();
            }
            let short = memory_short(total, available, settings.memory_percent);
            short_for = if short { short_for + 1 } else { 0 };
            let stalled = gap > STALL;
            if stalled {
                crate::activity::warn("safety", &format!("The computer didn't respond for {} s (or was asleep); {used}% of memory in use.", gap.as_secs()));
            }
            // Looking through the processes costs a little: every other tick, or straight away when there's trouble.
            let check = tick.is_multiple_of(2) || short || stalled || vram.is_some_and(|v| v >= settings.vram_percent);
            let running = check && !ai_pids(&mut system).is_empty();
            with_state(|s| {
                s.settings = settings.clone();
                s.memory_used_percent = used;
                s.vram_used_percent = vram;
                if check {
                    s.ai_running = running;
                }
            });
            if !settings.enabled {
                continue;
            }
            let cooling = stopped_at.is_some_and(|t| t.elapsed() < COOLDOWN);
            if running && !cooling {
                let reason = if stalled && used >= 85 {
                    Some(format!("the computer froze for {} s with {used}% of memory in use", gap.as_secs()))
                } else if short_for >= 2 {
                    Some(format!("memory ran low ({used}% in use, {} MB free)", available / (1024 * 1024)))
                } else {
                    vram.filter(|v| *v >= settings.vram_percent).map(|v| format!("the graphics card's memory is {v}% full"))
                };
                if let Some(reason) = reason {
                    step_in(&app, &reason, false);
                    stopped_at = Some(Instant::now());
                    short_for = 0;
                }
            } else if settings.close_app && stopped_at.is_some_and(|t| t.elapsed() >= Duration::from_secs(15) && t.elapsed() < COOLDOWN) && short_for >= 5 {
                step_in(&app, &format!("memory is still low ({used}% in use)"), true);
            }
        }
    });
}

#[tauri::command]
pub fn safety_status() -> Status {
    with_state(|s| {
        s.settings = load();
        s.clone()
    })
}

#[tauri::command]
pub fn safety_set(settings: Settings) -> Result<Settings, String> {
    let settings = settings.clean();
    let file = FILE.get().ok_or("Not ready yet")?;
    std::fs::write(file, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    crate::activity::info("safety", &format!("Safety stop settings: {}, stop the AI at {}% memory / {}% graphics memory{}.", if settings.enabled { "on" } else { "off" }, settings.memory_percent, settings.vram_percent, if settings.close_app { ", close BridgeDeck if that's not enough" } else { "" }));
    Ok(settings)
}

/// Stops the AI models now (Settings, the tray menu).
#[tauri::command]
pub fn safety_stop_ai() -> usize {
    let n = stop_ai();
    crate::activity::warn("safety", &format!("Stopped the AI models by hand ({n} program{}).", if n == 1 { "" } else { "s" }));
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_is_short_past_the_percentage_or_under_the_floor() {
        let gb = 1024 * 1024 * 1024;
        assert!(!memory_short(16 * gb, 4 * gb, 94));
        assert!(memory_short(16 * gb, gb / 2, 94)); // 97% in use
        assert!(memory_short(64 * gb, FLOOR - 1, 99)); // lots of RAM, but almost none left
        assert!(!memory_short(0, 0, 90));
    }

    #[test]
    fn settings_have_safe_defaults_and_limits() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
        assert!(s.enabled && !s.close_app);
        let odd = Settings { enabled: true, memory_percent: 10, vram_percent: 200, close_app: true }.clean();
        assert_eq!((odd.memory_percent, odd.vram_percent), (70, 100));
    }
}
