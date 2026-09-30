//! Clipboard sync: text or a picture copied on one computer can be pasted on the paired ones.
//!
//! A thread owns the system clipboard: it notices changes (the Mac's and Windows' change counters;
//! on Linux, text is compared) and sends what was copied to every paired device, and it puts what
//! those devices send onto this clipboard. Anything a password manager marks as concealed stays here.

use crate::bridgelink::BridgeLinkManager;
use crate::link::transport::{read_frame, read_raw, write_frame, write_raw, Request};
use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The stream path paired devices use (see `bridgelink::peer`).
pub const PATH: &str = "/clipboard";
const POLL: Duration = Duration::from_millis(400);
const MAX_TEXT: usize = 4 * 1024 * 1024;
/// Encoded PNG; below the link's raw-transfer limit.
const MAX_IMAGE: usize = 30 * 1024 * 1024;
/// Largest decoded picture accepted (about 8K × 8K).
const MAX_PIXELS: u64 = 64 * 1024 * 1024;
const SEND_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, PartialEq)]
pub enum Clip {
    Text(String),
    Image { width: u32, height: u32, rgba: Vec<u8> },
}

impl Clip {
    fn fingerprint(&self) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        match self {
            Clip::Text(text) => (0u8, text).hash(&mut hasher),
            Clip::Image { width, height, rgba } => (1u8, width, height, rgba).hash(&mut hasher),
        }
        hasher.finish()
    }

    fn kind(&self) -> &'static str {
        match self {
            Clip::Text(_) => "text",
            Clip::Image { .. } => "image",
        }
    }

    fn summary(&self) -> String {
        match self {
            Clip::Text(text) => {
                let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
                let short: String = line.chars().take(60).collect();
                if short.len() < line.len() { format!("{short}…") } else { short }
            }
            Clip::Image { width, height, .. } => format!("Picture {width} × {height}"),
        }
    }
}

/// Sent before the bytes: what they are.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Header {
    Text,
    Image { width: u32, height: u32 },
}

#[derive(Serialize, Deserialize)]
struct Ack {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// "sent" or "received".
    pub direction: &'static str,
    /// Where it came from, or where it went.
    pub peers: Vec<String>,
    pub kind: &'static str,
    pub summary: String,
    pub at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    /// The clipboard could be opened on this computer.
    pub available: bool,
    pub last: Option<Activity>,
    /// Why the last copy didn't reach a device.
    pub errors: Vec<String>,
}

struct State {
    /// Off until the settings arrive from the UI, so nothing is sent before the user's choice is known.
    enabled: bool,
    available: bool,
    last: Option<Activity>,
    errors: Vec<String>,
    apply: Option<mpsc::Sender<Clip>>,
}

static STATE: Mutex<State> = Mutex::new(State { enabled: false, available: false, last: None, errors: Vec::new(), apply: None });

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn status() -> Status {
    let state = state();
    Status { enabled: state.enabled, available: state.available, last: state.last.clone(), errors: state.errors.clone() }
}

#[tauri::command]
pub fn clipboard_status() -> Status {
    status()
}

#[tauri::command]
pub fn clipboard_settings(enabled: bool) -> Status {
    state().enabled = enabled;
    status()
}

/// Starts the clipboard thread (once, at launch).
pub fn start(manager: BridgeLinkManager) {
    let (tx, rx) = mpsc::channel();
    state().apply = Some(tx);
    std::thread::Builder::new()
        .name("clipboard".into())
        .spawn(move || watch(manager, rx))
        .ok();
}

fn watch(manager: BridgeLinkManager, incoming: mpsc::Receiver<Clip>) {
    let Ok(mut board) = arboard::Clipboard::new() else { return };
    state().available = true;
    let mut last_count = platform::change_count();
    // What's on the clipboard now was copied before BridgeDeck started: not sent.
    let mut last = read(&mut board, last_count.is_some()).ok().flatten().map(|clip| clip.fingerprint());
    loop {
        match incoming.recv_timeout(POLL) {
            Ok(clip) => {
                if write(&mut board, &clip).is_ok() {
                    last = Some(clip.fingerprint());
                }
                last_count = platform::change_count();
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let count = platform::change_count();
        if count.is_some() && count == last_count {
            continue;
        }
        let enabled = state().enabled;
        if !enabled {
            // Turning sync on later doesn't send what was copied while it was off.
            last_count = count;
            last = if count.is_some() { None } else { read(&mut board, false).ok().flatten().map(|clip| clip.fingerprint()) };
            continue;
        }
        if platform::concealed() {
            last_count = count;
            continue;
        }
        let clip = match read(&mut board, count.is_some()) {
            Ok(clip) => clip,
            // Another app has the clipboard open; try again on the next tick.
            Err(()) => continue,
        };
        last_count = count;
        let Some(clip) = clip else { continue };
        let fingerprint = clip.fingerprint();
        if last == Some(fingerprint) {
            continue;
        }
        last = Some(fingerprint);
        send_to_all(&manager, clip);
    }
}

/// What's on the clipboard: text first, then a picture (only where changes can be detected cheaply;
/// reading a picture is too slow to repeat every tick). Err: the clipboard is busy.
fn read(board: &mut arboard::Clipboard, images: bool) -> Result<Option<Clip>, ()> {
    match board.get_text() {
        Ok(text) if !text.is_empty() && text.len() <= MAX_TEXT => return Ok(Some(Clip::Text(text))),
        Ok(_) => return Ok(None),
        Err(arboard::Error::ContentNotAvailable) | Err(arboard::Error::ConversionFailure) => {}
        Err(arboard::Error::ClipboardOccupied) => return Err(()),
        Err(_) => return Ok(None),
    }
    if !images {
        return Ok(None);
    }
    match board.get_image() {
        Ok(image) if (image.width * image.height) as u64 <= MAX_PIXELS => {
            Ok(Some(Clip::Image { width: image.width as u32, height: image.height as u32, rgba: image.bytes.into_owned() }))
        }
        Err(arboard::Error::ClipboardOccupied) => Err(()),
        _ => Ok(None),
    }
}

fn write(board: &mut arboard::Clipboard, clip: &Clip) -> Result<(), arboard::Error> {
    match clip {
        Clip::Text(text) => board.set_text(text.clone()),
        Clip::Image { width, height, rgba } => board.set_image(arboard::ImageData {
            width: *width as usize,
            height: *height as usize,
            bytes: std::borrow::Cow::Borrowed(rgba),
        }),
    }
}

fn encode(clip: &Clip) -> Result<(Header, Vec<u8>), String> {
    match clip {
        Clip::Text(text) => Ok((Header::Text, text.as_bytes().to_vec())),
        Clip::Image { width, height, rgba } => {
            let mut png_bytes = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut png_bytes, *width, *height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                encoder.set_compression(png::Compression::Fast);
                let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
                writer.write_image_data(rgba).map_err(|e| e.to_string())?;
            }
            if png_bytes.len() > MAX_IMAGE {
                return Err("The picture is too large to send".into());
            }
            Ok((Header::Image { width: *width, height: *height }, png_bytes))
        }
    }
}

fn decode(header: &Header, bytes: Vec<u8>) -> Result<Clip, String> {
    match header {
        Header::Text => {
            if bytes.len() > MAX_TEXT {
                return Err("The text is too long".into());
            }
            String::from_utf8(bytes).map(Clip::Text).map_err(|_| "The text isn't valid UTF-8".into())
        }
        Header::Image { width, height } => {
            if (*width as u64) * (*height as u64) > MAX_PIXELS || bytes.len() > MAX_IMAGE {
                return Err("The picture is too large".into());
            }
            let limits = png::Limits { bytes: (MAX_PIXELS * 4) as usize };
            let mut reader = png::Decoder::new_with_limits(std::io::Cursor::new(bytes), limits).read_info().map_err(|e| e.to_string())?;
            let mut rgba = vec![0; reader.output_buffer_size()];
            let info = reader.next_frame(&mut rgba).map_err(|e| e.to_string())?;
            if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight || (info.width, info.height) != (*width, *height) {
                return Err("Unexpected picture format".into());
            }
            rgba.truncate(info.buffer_size());
            Ok(Clip::Image { width: info.width, height: info.height, rgba })
        }
    }
}

/// Sends a copy to every paired device at once; a device that's off simply misses it (an old
/// clipboard arriving later would be a surprise, so nothing is queued).
fn send_to_all(manager: &BridgeLinkManager, clip: Clip) {
    let peers = crate::bridgelink::peer::paired_peers(manager);
    if peers.is_empty() {
        return;
    }
    let (header, bytes) = match encode(&clip) {
        Ok(encoded) => encoded,
        Err(error) => {
            state().errors = vec![error];
            return;
        }
    };
    let (kind, summary) = (clip.kind(), clip.summary());
    let manager = manager.clone();
    tauri::async_runtime::spawn(async move {
        let header = serde_json::to_string(&header).unwrap_or_default();
        let sends = peers.iter().map(|(id, name)| {
            let (manager, header, bytes) = (manager.clone(), header.clone(), &bytes);
            async move {
                let result = tokio::time::timeout(SEND_TIMEOUT, send_one(&manager, id, header, bytes)).await.unwrap_or_else(|_| Err("timed out".into()));
                (name.clone(), result)
            }
        });
        let results = futures_util::future::join_all(sends).await;
        let mut state = state();
        let reached: Vec<String> = results.iter().filter(|(_, r)| r.is_ok()).map(|(name, _)| name.clone()).collect();
        state.errors = results.into_iter().filter_map(|(name, r)| r.err().map(|e| format!("{name}: {e}"))).collect();
        if !reached.is_empty() {
            state.last = Some(Activity { direction: "sent", peers: reached, kind, summary, at: now_ms() });
        }
    });
}

async fn send_one(manager: &BridgeLinkManager, instance_id: &str, header: String, bytes: &[u8]) -> Result<(), String> {
    let (link, addresses, fingerprint) = crate::bridgelink::peer::link_to(manager, instance_id)?;
    let request = Request { method: "POST".into(), path: PATH.into(), body: header };
    let (mut send, mut recv) = link.open_stream(&addresses, &fingerprint, &request).await?;
    write_raw(&mut send, bytes).await?;
    let _ = send.finish();
    let ack: Ack = read_frame(&mut recv).await?;
    if ack.ok { Ok(()) } else { Err(ack.error.unwrap_or_else(|| "refused".into())) }
}

/// A paired device sent its clipboard (the caller already checked it is paired).
pub async fn serve(peer_name: String, header: String, mut send: quinn::SendStream, mut recv: quinn::RecvStream) {
    let result = async {
        let header: Header = serde_json::from_str(&header).map_err(|_| "Invalid clipboard request".to_string())?;
        let bytes = read_raw(&mut recv).await?;
        let (enabled, apply) = {
            let state = state();
            (state.enabled, state.apply.clone())
        };
        if !enabled {
            return Err("Clipboard sync is off there".to_string());
        }
        let clip = decode(&header, bytes)?;
        let (kind, summary) = (clip.kind(), clip.summary());
        apply.ok_or("The clipboard isn't available there")?.send(clip).map_err(|_| "The clipboard isn't available there".to_string())?;
        state().last = Some(Activity { direction: "received", peers: vec![peer_name], kind, summary, at: now_ms() });
        Ok(())
    }
    .await;
    let ack = match result {
        Ok(()) => Ack { ok: true, error: None },
        Err(error) => Ack { ok: false, error: Some(error) },
    };
    let _ = write_frame(&mut send, &ack).await;
    let _ = send.finish();
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2_app_kit::NSPasteboard;

    pub fn change_count() -> Option<i64> {
        Some(NSPasteboard::generalPasteboard().changeCount() as i64)
    }

    /// Password managers and similar apps mark what they copy (nspasteboard.org).
    pub fn concealed() -> bool {
        let Some(types) = NSPasteboard::generalPasteboard().types() else { return false };
        (0..types.count()).any(|i| {
            let kind = types.objectAtIndex(i).to_string();
            kind == "org.nspasteboard.ConcealedType" || kind == "org.nspasteboard.TransientType" || kind == "org.nspasteboard.AutoGeneratedType"
        })
    }
}

#[cfg(target_os = "windows")]
mod platform {
    #[link(name = "user32")]
    extern "system" {
        fn GetClipboardSequenceNumber() -> u32;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
    }

    pub fn change_count() -> Option<i64> {
        Some(unsafe { GetClipboardSequenceNumber() } as i64)
    }

    /// Password managers mark what they copy as excluded from clipboard monitoring and history.
    pub fn concealed() -> bool {
        ["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore"].iter().any(|name| {
            let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                let format = RegisterClipboardFormatW(wide.as_ptr());
                format != 0 && IsClipboardFormatAvailable(format) != 0
            }
        })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    /// No cheap change counter: the text is compared each tick instead.
    pub fn change_count() -> Option<i64> {
        None
    }

    pub fn concealed() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_and_pictures_survive_the_trip() {
        let text = Clip::Text("héllo\nworld".into());
        let (header, bytes) = encode(&text).unwrap();
        assert_eq!(decode(&header, bytes).unwrap(), text);

        let rgba: Vec<u8> = (0..(7 * 5 * 4)).map(|i| (i * 13 % 256) as u8).collect();
        let image = Clip::Image { width: 7, height: 5, rgba };
        let (header, bytes) = encode(&image).unwrap();
        assert_eq!(header, Header::Image { width: 7, height: 5 });
        assert_eq!(decode(&header, bytes).unwrap(), image);
    }

    #[test]
    fn a_picture_that_lies_about_its_size_is_refused() {
        let image = Clip::Image { width: 2, height: 2, rgba: vec![255; 16] };
        let (_, bytes) = encode(&image).unwrap();
        assert!(decode(&Header::Image { width: 3, height: 2 }, bytes.clone()).is_err());
        assert!(decode(&Header::Image { width: 100_000, height: 100_000 }, bytes).is_err());
    }

    #[test]
    fn summaries_are_short_and_on_one_line() {
        let long = Clip::Text(format!("first\n  second {}", "x".repeat(100)));
        let summary = long.summary();
        assert!(summary.starts_with("first second"));
        assert!(summary.ends_with('…'));
        assert_eq!(Clip::Image { width: 3, height: 4, rgba: vec![] }.summary(), "Picture 3 × 4");
        assert_ne!(Clip::Text("a".into()).fingerprint(), Clip::Text("b".into()).fingerprint());
    }
}
