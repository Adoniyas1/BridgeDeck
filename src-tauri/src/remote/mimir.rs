//! Mimir looking at a paired computer's screen, so it can tell the person what it sees and what to
//! do. Look only: Mimir sends no clicks or keys. It uses the same remote-control session a person
//! uses, so the other computer's own rules apply (control can be off there, or ask first) and its
//! "being controlled" banner says it's Mimir, with Stop.
//!
//! On this computer, BridgeDeck asks before Mimir first looks at a computer; a yes lasts 10
//! minutes. The session closes after 3 idle minutes.

use super::{viewer, HostMsg, ViewerMsg};
use crate::bridgelink::BridgeLinkManager;
use base64::Engine;
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::ipc::InvokeResponseBody;

const GRANT: Duration = Duration::from_secs(10 * 60);
const IDLE: Duration = Duration::from_secs(3 * 60);
const LOOK_WIDTH: u32 = 1366;

struct Session {
    peer: String,
    id: String,
    packets: std::sync::mpsc::Receiver<Vec<u8>>,
    used: Instant,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// When the person last allowed Mimir to look at each computer.
static GRANTS: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) static TEST_ALLOW: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Asks the person here (once per 10 minutes for each computer).
fn allow(app: Option<&tauri::AppHandle>, peer: &str, name: &str) -> Result<(), String> {
    if GRANTS.lock().map(|g| g.iter().any(|(p, at)| p == peer && at.elapsed() < GRANT)).unwrap_or(false) {
        return Ok(());
    }
    #[cfg(test)]
    let yes = {
        let _ = (app, name);
        TEST_ALLOW.load(std::sync::atomic::Ordering::Relaxed)
    };
    #[cfg(not(test))]
    let yes = {
        let Some(app) = app else { return Err("There's no BridgeDeck window to ask you in".into()) };
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        app.dialog()
            .message(format!("Mimir wants to see the screen of {name} (it can only look, not click or type). It shows there as a remote session you can stop. Allowed for 10 minutes."))
            .title("Let Mimir see the other computer?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Don't".into()))
            .blocking_show()
    };
    if !yes {
        return Err("You chose not to allow it".into());
    }
    if let Ok(mut grants) = GRANTS.lock() {
        grants.retain(|(p, at)| p != peer && at.elapsed() < GRANT);
        grants.push((peer.to_string(), Instant::now()));
    }
    Ok(())
}

fn close(session: Session) {
    let _ = viewer::remote_disconnect(session.id);
}

/// Drops the session after a few idle minutes.
fn tidy() {
    if let Ok(mut slot) = SESSION.lock() {
        if slot.as_ref().is_some_and(|s| s.used.elapsed() > IDLE) {
            if let Some(session) = slot.take() {
                close(session);
            }
        }
    }
}

fn open(manager: &BridgeLinkManager, peer: &str, slot: &mut Option<Session>) -> Result<(), String> {
    if slot.as_ref().is_some_and(|s| s.peer == peer && s.used.elapsed() < IDLE) {
        return Ok(());
    }
    if let Some(old) = slot.take() {
        close(old);
    }
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let hello = ViewerMsg::Hello { monitor: 0, max_width: LOOK_WIDTH, quality: 70, by: Some("Mimir".into()) };
    let id = tauri::async_runtime::block_on(viewer::connect(manager, peer, hello, move |body| {
        if let InvokeResponseBody::Raw(bytes) = body {
            let _ = tx.send(bytes);
        }
    }))?;
    *slot = Some(Session { peer: peer.to_string(), id, packets: rx, used: Instant::now() });
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(30));
        tidy();
        if SESSION.lock().map(|s| s.is_none()).unwrap_or(true) {
            break;
        }
    });
    Ok(())
}

/// A frame packet's header and payload; `None` for other events. An ended session is an error.
fn parse(packet: &[u8]) -> Result<Option<(HostMsg, &[u8])>, String> {
    match packet.first() {
        Some(1) if packet.len() >= 5 => {
            let len = u32::from_be_bytes(packet[1..5].try_into().unwrap_or_default()) as usize;
            let header: HostMsg = serde_json::from_slice(packet.get(5..5 + len).ok_or("Damaged frame")?).map_err(|e| e.to_string())?;
            Ok(Some((header, &packet[5 + len..])))
        }
        Some(0) => {
            let value: Value = serde_json::from_slice(&packet[1..]).unwrap_or_default();
            if value["type"] == "ended" {
                return Err(format!("The other computer ended the session: {}", value["reason"].as_str().unwrap_or("")));
            }
            Ok(None)
        }
        _ => Ok(None),
    }
}

/// A screenshot of `monitor` on a paired computer: a JPEG with its size.
/// `app` is where the person is asked first.
pub fn look(manager: &BridgeLinkManager, app: Option<&tauri::AppHandle>, peer: &str, name: &str, monitor: usize) -> Result<Value, String> {
    allow(app, peer, name)?;
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    open(manager, peer, &mut slot)?;
    let session = slot.as_mut().ok_or("The session ended")?;
    while session.packets.try_recv().is_ok() {}
    // Starting over makes the next frame the whole screen in one JPEG.
    viewer::remote_settings(session.id.clone(), Some(monitor), Some(LOOK_WIDTH), Some(70))?;
    let _ = viewer::remote_frame_drawn(session.id.clone());
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let Ok(packet) = session.packets.recv_timeout(Duration::from_millis(500)) else { continue };
        let parsed = match parse(&packet) {
            Ok(parsed) => parsed,
            Err(error) => {
                slot.take();
                return Err(error);
            }
        };
        let Some((HostMsg::Frame { width, height, tiles, .. }, payload)) = parsed else { continue };
        if tiles.len() == 1 && (tiles[0].x, tiles[0].y, tiles[0].w, tiles[0].h) == (0, 0, width, height) {
            session.used = Instant::now();
            return Ok(json!({ "width": width, "height": height, "jpeg": base64::engine::general_purpose::STANDARD.encode(payload) }));
        }
        // A partial frame from before the restart: ask for the next one.
        let _ = viewer::remote_frame_drawn(session.id.clone());
    }
    Err("The other computer didn't send its screen in time".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::platform::tests::{FakeScreen, FAKE};

    #[test]
    fn mimir_sees_the_other_screen_only_when_allowed_and_says_so_there() {
        let _serial = viewer::tests::SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let fake = FakeScreen::default();
        *FAKE.lock().unwrap() = Some(fake.clone());
        let (here, _there, there_id) = crate::bridgelink::peer::tests::paired_pair();

        TEST_ALLOW.store(false, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(look(&here, None, &there_id, "PC", 0).unwrap_err(), "You chose not to allow it");

        TEST_ALLOW.store(true, std::sync::atomic::Ordering::Relaxed);
        let shot = look(&here, None, &there_id, "PC", 0).unwrap();
        assert_eq!((shot["width"].as_u64(), shot["height"].as_u64()), (Some(320), Some(200)));
        let jpeg = base64::engine::general_purpose::STANDARD.decode(shot["jpeg"].as_str().unwrap()).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "a JPEG");
        let banner = crate::remote::host::status().sessions;
        assert!(banner.iter().any(|s| s.peer_name.starts_with("Mimir on")), "the other computer's banner says it's Mimir: {banner:?}");
        // A second look reuses the session and is again the whole screen; nothing was typed or clicked.
        assert_eq!(look(&here, None, &there_id, "PC", 0).unwrap()["width"], 320);
        assert!(fake.input.lock().unwrap().is_empty());

        if let Some(session) = SESSION.lock().unwrap().take() {
            close(session);
        }
        GRANTS.lock().unwrap().clear();
        *FAKE.lock().unwrap() = None;
    }
}
