//! This computer being controlled by a paired device.

use super::{audio, codec, input::InputEvent, platform, video, HostMsg, ViewerMsg};
use crate::link::transport::{read_frame, write_frame, write_raw};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

/// How long the host waits for the screen to change before answering with an empty frame.
const IDLE_REPLY: Duration = Duration::from_secs(1);
const CHANGE_POLL: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Paired devices may control this computer (D15: on by default).
    pub allow: bool,
    /// Ask on this computer before each session.
    pub ask_first: bool,
}

static SETTINGS: Mutex<Settings> = Mutex::new(Settings { allow: true, ask_first: false });
/// Devices to ask about each time even when "ask first" is off for everyone.
static ASK_PEERS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Pressed on this computer, ends every remote session (registered only while one is running).
pub const STOP_SHORTCUT: &str = "CommandOrControl+Alt+Shift+S";

fn stop_shortcut(app: &Option<AppHandle>, on: bool) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let Some(app) = app else { return };
    let shortcuts = app.global_shortcut();
    if on {
        if !shortcuts.is_registered(STOP_SHORTCUT) {
            let _ = shortcuts.on_shortcut(STOP_SHORTCUT, |_, _, event| {
                if event.state == ShortcutState::Pressed {
                    stop_all();
                }
            });
        }
    } else {
        let _ = shortcuts.unregister(STOP_SHORTCUT);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSession {
    pub id: String,
    pub peer_id: String,
    pub peer_name: String,
    pub since: u64,
    #[serde(skip)]
    stop: Arc<AtomicBool>,
}

static SESSIONS: Mutex<Vec<ActiveSession>> = Mutex::new(Vec::new());

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub supported: bool,
    pub settings: Settings,
    pub sessions: Vec<ActiveSession>,
}

pub fn status() -> HostStatus {
    HostStatus {
        supported: platform::supported(),
        settings: *SETTINGS.lock().unwrap_or_else(|e| e.into_inner()),
        sessions: SESSIONS.lock().map(|s| s.clone()).unwrap_or_default(),
    }
}

fn emit(app: &Option<AppHandle>) {
    if let Some(app) = app {
        let _ = app.emit("remote-host", status());
    }
}

/// Ends every session (the banner's and the tray's Stop).
pub fn stop_all() {
    if let Ok(sessions) = SESSIONS.lock() {
        for session in sessions.iter() {
            session.stop.store(true, Ordering::Relaxed);
        }
    }
}

#[tauri::command]
pub fn remote_host_status() -> HostStatus {
    status()
}

#[tauri::command]
pub fn remote_host_settings(allow: bool, ask_first: bool, ask_peers: Option<Vec<String>>) -> HostStatus {
    *SETTINGS.lock().unwrap_or_else(|e| e.into_inner()) = Settings { allow, ask_first };
    *ASK_PEERS.lock().unwrap_or_else(|e| e.into_inner()) = ask_peers.unwrap_or_default();
    if !allow {
        stop_all();
    }
    status()
}

#[tauri::command]
pub fn remote_host_stop() -> HostStatus {
    stop_all();
    status()
}

fn ask(app: &AppHandle, peer_name: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .message(format!("{peer_name} wants to see and control this computer."))
        .title("Allow remote control?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Deny".into()))
        .show(move |allowed| {
            let _ = tx.send(allowed);
        });
    rx.recv_timeout(Duration::from_secs(60)).unwrap_or(false)
}

enum CaptureJob {
    Monitors(tokio::sync::oneshot::Sender<Result<Vec<platform::MonitorInfo>, String>>),
    /// (monitor, max width, quality, start over, H.264 wanted, reply)
    Frame(usize, u32, u8, bool, bool, tokio::sync::oneshot::Sender<Result<Shot, String>>),
}

/// One answer from the capture thread.
enum Shot {
    Tiles(codec::Encoded),
    /// An H.264 frame; `data` is empty when the screen didn't change.
    Video { width: u32, height: u32, key: bool, data: Vec<u8> },
}

impl Shot {
    fn changed(&self) -> bool {
        match self {
            Shot::Tiles(frame) => !frame.tiles.is_empty(),
            Shot::Video { data, .. } => !data.is_empty(),
        }
    }
}

/// H.264 for a session: the platform encoder, made for the current frame size and quality.
#[derive(Default)]
struct VideoState {
    encoder: Option<Box<dyn video::VideoEncoder>>,
    size: (u32, u32, u8),
    last: u64,
    since_key: u64,
    /// The encoder failed: tiles for the rest of the session.
    failed: bool,
}

impl VideoState {
    /// The next frame as H.264; `None` when H.264 isn't working here (the caller sends tiles).
    fn shot(&mut self, rgba: Vec<u8>, width: u32, height: u32, quality: u8, restart: bool) -> Option<Shot> {
        if self.failed {
            return None;
        }
        let (rgba, w, h) = video::even(rgba, width, height);
        let hash = codec::frame_hash(&rgba);
        if !restart && self.encoder.is_some() && self.size == (w, h, quality) && hash == self.last {
            return Some(Shot::Video { width: w, height: h, key: false, data: Vec::new() });
        }
        let fresh = restart || self.encoder.is_none() || self.size != (w, h, quality);
        if fresh {
            self.encoder = None;
            match video::encoder(w, h, quality) {
                Ok(encoder) => self.encoder = Some(encoder),
                Err(_) => {
                    self.failed = true;
                    return None;
                }
            }
            self.size = (w, h, quality);
        }
        let key = fresh || self.since_key >= video::KEY_EVERY;
        let nv12 = video::rgba_to_nv12(&rgba, w, h);
        match self.encoder.as_mut()?.encode(&nv12, w, h, key) {
            Ok(data) => {
                self.last = hash;
                let key = video::is_key(&data);
                self.since_key = if key { 0 } else { self.since_key + 1 };
                Some(Shot::Video { width: w, height: h, key, data })
            }
            Err(_) => {
                self.failed = true;
                self.encoder = None;
                None
            }
        }
    }
}

/// The capture thread: owns the platform capturer and the encoders.
fn capture_worker(jobs: mpsc::Receiver<CaptureJob>) {
    let mut capturer = platform::capturer();
    let mut encoder = codec::Encoder::default();
    let mut video = VideoState::default();
    let mut last_monitor = usize::MAX;
    while let Ok(job) = jobs.recv() {
        let capturer = match capturer.as_mut() {
            Ok(capturer) => capturer,
            Err(error) => {
                match job {
                    CaptureJob::Monitors(reply) => drop(reply.send(Err(error.clone()))),
                    CaptureJob::Frame(.., reply) => drop(reply.send(Err(error.clone()))),
                }
                continue;
            }
        };
        match job {
            CaptureJob::Monitors(reply) => drop(reply.send(capturer.monitors())),
            CaptureJob::Frame(monitor, max_width, quality, restart, h264, reply) => {
                let restart = restart || monitor != last_monitor;
                if restart {
                    encoder.reset();
                    last_monitor = monitor;
                }
                let frame = capturer.capture(monitor).and_then(|(pixels, w, h)| {
                    let (pixels, w, h) = codec::downscale(pixels, w, h, max_width);
                    if h264 && !video.failed {
                        if let Some(shot) = video.shot(pixels.clone(), w, h, quality, restart) {
                            return Ok(shot);
                        }
                        // H.264 just failed: start the tiles over with a whole frame.
                        encoder.reset();
                    }
                    encoder.encode(&pixels, w, h, quality).map(Shot::Tiles)
                });
                let _ = reply.send(frame);
            }
        }
    }
}

/// The input thread: owns the platform injector. Errors are reported once.
fn input_worker(events: mpsc::Receiver<(usize, InputEvent)>, errors: tokio::sync::mpsc::UnboundedSender<String>) {
    let mut injector = match platform::injector() {
        Ok(injector) => injector,
        Err(error) => {
            let _ = errors.send(error);
            return;
        }
    };
    let mut reported = false;
    while let Ok((monitor, event)) = events.recv() {
        if let Err(error) = injector.apply(monitor, &event) {
            if !reported {
                reported = true;
                let _ = errors.send(error);
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

async fn end(send: &mut quinn::SendStream, reason: impl Into<String>) {
    let _ = write_frame(send, &HostMsg::Ended { reason: reason.into() }).await;
    let _ = send.finish();
}

/// One session with a paired device that proved its certificate (`peer_id`, `peer_name` come from
/// the pairing record).
pub async fn serve(app: Option<AppHandle>, peer_id: String, peer_name: String, host_name: String, mut send: quinn::SendStream, mut recv: quinn::RecvStream) {
    if !platform::supported() && platform::capturer().is_err() {
        return end(&mut send, platform::UNSUPPORTED).await;
    }
    let settings = *SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    if !settings.allow {
        return end(&mut send, format!("Remote control of {host_name} is turned off in its BridgeDeck settings")).await;
    }
    let ask_this_one = ASK_PEERS.lock().map(|peers| peers.contains(&peer_id)).unwrap_or(false);
    if settings.ask_first || ask_this_one {
        let approved = match app.clone() {
            Some(app) => {
                let name = peer_name.clone();
                tauri::async_runtime::spawn_blocking(move || ask(&app, &name)).await.unwrap_or(false)
            }
            None => false,
        };
        if !approved {
            return end(&mut send, format!("Not allowed on {host_name}")).await;
        }
    }
    let hello = tokio::time::timeout(Duration::from_secs(10), read_frame::<ViewerMsg>(&mut recv)).await;
    let Ok(Ok(ViewerMsg::Hello { monitor, max_width, quality, by, codecs, audio: wants_audio })) = hello else {
        return end(&mut send, "Expected a hello").await;
    };

    let (jobs, job_rx) = mpsc::channel::<CaptureJob>();
    std::thread::spawn(move || capture_worker(job_rx));
    let (input_tx, input_rx) = mpsc::channel::<(usize, InputEvent)>();
    let (error_tx, mut error_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || input_worker(input_rx, error_tx));

    let (reply, monitors) = tokio::sync::oneshot::channel();
    let _ = jobs.send(CaptureJob::Monitors(reply));
    let monitors = match monitors.await {
        Ok(Ok(list)) if !list.is_empty() => list,
        Ok(Err(error)) => return end(&mut send, error).await,
        _ => return end(&mut send, "No display to share").await,
    };

    // Mimir viewing from the other computer says so in the banner and notification.
    let peer_name = match by.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(by) => format!("{} on {peer_name}", by.chars().take(24).collect::<String>()),
        None => peer_name,
    };
    let stop = Arc::new(AtomicBool::new(false));
    let id = uuid::Uuid::new_v4().to_string();
    if let Ok(mut sessions) = SESSIONS.lock() {
        sessions.push(ActiveSession { id: id.clone(), peer_id, peer_name: peer_name.clone(), since: now_ms(), stop: stop.clone() });
    }
    emit(&app);
    stop_shortcut(&app, true);
    if let Some(app) = &app {
        use tauri_plugin_notification::NotificationExt;
        let keys = if cfg!(target_os = "macos") { "Cmd+Option+Shift+S" } else { "Ctrl+Alt+Shift+S" };
        let _ = app.notification().builder().title("Remote control started").body(format!("{peer_name} is controlling this computer. Press {keys} to stop it, or use BridgeDeck's banner or tray menu.")).show();
    }

    let monitor = Arc::new(AtomicUsize::new(monitor.min(monitors.len() - 1)));
    let max_width = Arc::new(AtomicU32::new(max_width.clamp(320, 8192)));
    let quality = Arc::new(AtomicU32::new(quality.clamp(20, 95) as u32));
    let restart = Arc::new(AtomicBool::new(true));
    let h264 = Arc::new(AtomicBool::new(video::available() && codecs.iter().any(|c| c == video::H264)));
    let sound = Arc::new(AtomicBool::new(wants_audio && audio::available()));
    let ready = HostMsg::Ready {
        monitors,
        monitor: monitor.load(Ordering::Relaxed),
        host_name: host_name.clone(),
        platform: std::env::consts::OS.into(),
        video: h264.load(Ordering::Relaxed).then(|| video::H264.to_string()),
        audio: audio::available(),
    };

    // Host -> viewer goes through one writer, so sound can go out between frames.
    let (out, mut out_rx) = tokio::sync::mpsc::channel::<(HostMsg, Vec<u8>)>(32);
    let writer = {
        let stop = stop.clone();
        tauri::async_runtime::spawn(async move {
            while let Some((header, payload)) = out_rx.recv().await {
                let ended = matches!(header, HostMsg::Ended { .. });
                if write_frame(&mut send, &header).await.is_err() || (!payload.is_empty() && write_raw(&mut send, &payload).await.is_err()) {
                    stop.store(true, Ordering::Relaxed);
                    break;
                }
                if ended {
                    break;
                }
            }
            let _ = send.finish();
        })
    };
    {
        let out = out.clone();
        let failed = out.clone();
        audio::spawn(
            sound.clone(),
            stop.clone(),
            move |samples, rate, channels| {
                let bytes = audio::to_bytes(&samples);
                // Dropped when the link is behind.
                let _ = out.try_send((HostMsg::Audio { rate, channels, bytes: bytes.len() as u32 }, bytes));
            },
            move |error| {
                eprintln!("remote sound: {error}");
                let _ = failed.try_send((HostMsg::Audio { rate: 0, channels: 0, bytes: 0 }, Vec::new()));
            },
        );
    }

    // Viewer -> host: input goes straight to the input thread; frame requests to the loop below.
    let (next_tx, mut next_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let reader = {
        let (monitor, max_width, quality, restart, stop, h264, sound) = (monitor.clone(), max_width.clone(), quality.clone(), restart.clone(), stop.clone(), h264.clone(), sound.clone());
        tauri::async_runtime::spawn(async move {
            while let Ok(message) = read_frame::<ViewerMsg>(&mut recv).await {
                match message {
                    ViewerMsg::Input { events } => {
                        let at = monitor.load(Ordering::Relaxed);
                        for event in events.into_iter().take(500) {
                            let _ = input_tx.send((at, event));
                        }
                    }
                    ViewerMsg::Next => {
                        let _ = next_tx.send(());
                    }
                    ViewerMsg::Settings { monitor: m, max_width: w, quality: q, audio: a, codec } => {
                        if let Some(a) = a {
                            sound.store(a && audio::available(), Ordering::Relaxed);
                        }
                        if let Some(codec) = codec {
                            h264.store(codec == video::H264 && video::available(), Ordering::Relaxed);
                        }
                        if let Some(m) = m {
                            monitor.store(m, Ordering::Relaxed);
                        }
                        if let Some(w) = w {
                            max_width.store(w.clamp(320, 8192), Ordering::Relaxed);
                        }
                        if let Some(q) = q {
                            quality.store(q.clamp(20, 95) as u32, Ordering::Relaxed);
                        }
                        restart.store(true, Ordering::Relaxed);
                    }
                    ViewerMsg::Stop | ViewerMsg::Hello { .. } => break,
                }
            }
            stop.store(true, Ordering::Relaxed);
        })
    };

    let reason = 'session: {
        if out.send((ready, Vec::new())).await.is_err() {
            break 'session None;
        }
        let mut seq = 0u64;
        loop {
            // Wait for the viewer to ask (it asks after drawing the previous frame).
            let asked = loop {
                if stop.load(Ordering::Relaxed) {
                    break false;
                }
                if let Ok(error) = error_rx.try_recv() {
                    break 'session Some(error);
                }
                match tokio::time::timeout(Duration::from_millis(200), next_rx.recv()).await {
                    Ok(Some(())) => break true,
                    Ok(None) => break false,
                    Err(_) => continue,
                }
            };
            if !asked {
                break 'session Some(format!("Stopped on {host_name}"));
            }
            // Capture until something changed (or a second passed), then answer.
            let started = Instant::now();
            let frame = loop {
                let (reply, frame) = tokio::sync::oneshot::channel();
                let restart_now = restart.swap(false, Ordering::Relaxed);
                let job = CaptureJob::Frame(monitor.load(Ordering::Relaxed), max_width.load(Ordering::Relaxed), quality.load(Ordering::Relaxed) as u8, restart_now, h264.load(Ordering::Relaxed), reply);
                if jobs.send(job).is_err() {
                    break 'session Some("Screen capture stopped".into());
                }
                let frame = match frame.await {
                    Ok(Ok(frame)) => frame,
                    Ok(Err(error)) => break 'session Some(error),
                    Err(_) => break 'session Some("Screen capture stopped".into()),
                };
                if frame.changed() || started.elapsed() >= IDLE_REPLY || stop.load(Ordering::Relaxed) {
                    break frame;
                }
                tokio::time::sleep(CHANGE_POLL).await;
            };
            seq += 1;
            let message = match frame {
                // Nothing changed: an empty frame, so the viewer asks again.
                Shot::Video { width, height, data, .. } if data.is_empty() => (HostMsg::Frame { seq, width, height, tiles: Vec::new(), bytes: 0 }, data),
                Shot::Video { width, height, key, data } => (HostMsg::Video { seq, width, height, key, bytes: data.len() as u32 }, data),
                Shot::Tiles(frame) => (HostMsg::Frame { seq, width: frame.width, height: frame.height, tiles: frame.tiles, bytes: frame.data.len() as u32 }, frame.data),
            };
            if out.send(message).await.is_err() {
                break 'session None;
            }
        }
    };
    if let Some(reason) = reason {
        let _ = out.send((HostMsg::Ended { reason }, Vec::new())).await;
    }
    drop(out);
    stop.store(true, Ordering::Relaxed);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    reader.abort();
    let none_left = SESSIONS.lock().map(|mut sessions| {
        sessions.retain(|s| s.id != id);
        sessions.is_empty()
    }).unwrap_or(true);
    if none_left {
        stop_shortcut(&app, false);
    }
    emit(&app);
}
