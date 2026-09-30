//! This computer showing a paired device's screen (the `remote-session` tab).
//!
//! Frames go to the tab through a Tauri channel as raw bytes: `1`, a 4-byte big-endian header length,
//! the `HostMsg::Frame` JSON, then the tiles' JPEGs. Other events are `0` followed by JSON. The tab
//! calls `remote_frame_drawn` after drawing, which asks the host for the next frame.

use super::{input::InputEvent, HostMsg, ViewerMsg, SESSION_PATH};
use crate::{
    bridgelink::BridgeLinkManager,
    link::transport::{read_frame, read_raw, write_frame, Request},
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::{mpsc, Semaphore};

/// Frames requested ahead: the host captures the next frame while this one travels and is drawn.
const IN_FLIGHT: usize = 2;

struct Session {
    tx: mpsc::UnboundedSender<ViewerMsg>,
    /// One permit per frame the tab has drawn; each lets the reader ask for another.
    drawn: Arc<Semaphore>,
}

static SESSIONS: Mutex<Option<HashMap<String, Session>>> = Mutex::new(None);

fn with_session<T>(id: &str, f: impl FnOnce(&Session) -> T) -> Result<T, String> {
    let sessions = SESSIONS.lock().map_err(|_| "sessions poisoned")?;
    sessions.as_ref().and_then(|s| s.get(id)).map(f).ok_or_else(|| "This remote session has ended".to_string())
}

fn remove(id: &str) {
    if let Ok(mut sessions) = SESSIONS.lock() {
        if let Some(sessions) = sessions.as_mut() {
            sessions.remove(id);
        }
    }
}

fn event(value: serde_json::Value) -> InvokeResponseBody {
    let mut bytes = vec![0u8];
    bytes.extend_from_slice(value.to_string().as_bytes());
    InvokeResponseBody::Raw(bytes)
}

/// Packs a frame for the tab.
pub fn frame_packet(header: &HostMsg, payload: &[u8]) -> Vec<u8> {
    let header = serde_json::to_vec(header).unwrap_or_default();
    let mut bytes = Vec::with_capacity(5 + header.len() + payload.len());
    bytes.push(1);
    bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(payload);
    bytes
}

/// Connects to a paired device; returns once it accepted (or refused). `sink` gets every frame and event.
pub async fn connect(
    manager: &BridgeLinkManager,
    peer: &str,
    hello: ViewerMsg,
    sink: impl Fn(InvokeResponseBody) + Send + Sync + 'static,
) -> Result<String, String> {
    let (link, addresses, fingerprint) = crate::bridgelink::peer::link_to(manager, peer)?;
    let request = Request { method: "POST".into(), path: SESSION_PATH.into(), body: String::new() };
    let (mut send, mut recv) = link.open_stream(&addresses, &fingerprint, &request).await?;
    write_frame(&mut send, &hello).await?;
    // The other computer may ask its person first (up to a minute).
    let first = tokio::time::timeout(Duration::from_secs(75), read_frame::<HostMsg>(&mut recv))
        .await
        .map_err(|_| "The other computer did not answer".to_string())??;
    let ready = match first {
        ready @ HostMsg::Ready { .. } => ready,
        HostMsg::Ended { reason } => return Err(reason),
        HostMsg::Frame { .. } => return Err("Unexpected answer".into()),
    };
    sink(event(json!({ "type": "ready", "ready": ready })));

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<ViewerMsg>();
    let drawn = Arc::new(Semaphore::new(0));
    {
        let mut sessions = SESSIONS.lock().map_err(|_| "sessions poisoned")?;
        sessions.get_or_insert_with(HashMap::new).insert(id.clone(), Session { tx: tx.clone(), drawn: drawn.clone() });
    }

    // Writer: everything the tab sends, in order. Input is never queued behind video (other direction).
    tauri::async_runtime::spawn(async move {
        while let Some(message) = rx.recv().await {
            let stop = message == ViewerMsg::Stop;
            if write_frame(&mut send, &message).await.is_err() || stop {
                break;
            }
        }
        let _ = send.finish();
    });

    // Reader: frames to the tab, then the next request once the tab drew it.
    let reader_id = id.clone();
    for _ in 0..IN_FLIGHT {
        let _ = tx.send(ViewerMsg::Next);
    }
    tauri::async_runtime::spawn(async move {
        let reason = loop {
            match read_frame::<HostMsg>(&mut recv).await {
                Ok(header @ HostMsg::Frame { .. }) => {
                    let HostMsg::Frame { bytes, .. } = header else { unreachable!() };
                    let payload = if bytes > 0 {
                        match read_raw(&mut recv).await {
                            Ok(payload) => payload,
                            Err(error) => break error,
                        }
                    } else {
                        Vec::new()
                    };
                    sink(InvokeResponseBody::Raw(frame_packet(&header, &payload)));
                    // Ask for more once drawn; if the tab is hidden it doesn't draw, and the host waits.
                    match drawn.acquire().await {
                        Ok(permit) => permit.forget(),
                        Err(_) => break "Disconnected".into(),
                    }
                    if tx.send(ViewerMsg::Next).is_err() {
                        break "Disconnected".into();
                    }
                }
                Ok(HostMsg::Ended { reason }) => break reason,
                Ok(HostMsg::Ready { .. }) => {}
                Err(error) => break if error.contains("closed") || error.contains("finished") { "Disconnected".into() } else { error },
            }
        };
        sink(event(json!({ "type": "ended", "reason": reason })));
        remove(&reader_id);
    });
    Ok(id)
}

#[tauri::command]
pub async fn remote_connect(
    peer: String,
    monitor: usize,
    max_width: u32,
    quality: u8,
    on_event: Channel<InvokeResponseBody>,
    manager: tauri::State<'_, BridgeLinkManager>,
) -> Result<String, String> {
    let manager = manager.inner().clone();
    connect(&manager, &peer, ViewerMsg::Hello { monitor, max_width, quality }, move |body| {
        let _ = on_event.send(body);
    })
    .await
}

#[tauri::command]
pub fn remote_frame_drawn(session: String) -> Result<(), String> {
    with_session(&session, |s| s.drawn.add_permits(1))
}

#[tauri::command]
pub fn remote_input(session: String, events: Vec<InputEvent>) -> Result<(), String> {
    with_session(&session, |s| s.tx.send(ViewerMsg::Input { events }).map_err(|_| "Disconnected".to_string()))?
}

#[tauri::command]
pub fn remote_settings(session: String, monitor: Option<usize>, max_width: Option<u32>, quality: Option<u8>) -> Result<(), String> {
    with_session(&session, |s| {
        // The host starts over with a whole frame on the next request.
        let _ = s.tx.send(ViewerMsg::Settings { monitor, max_width, quality });
    })
}

#[tauri::command]
pub fn remote_disconnect(session: String) -> Result<(), String> {
    let _ = with_session(&session, |s| {
        let _ = s.tx.send(ViewerMsg::Stop);
        s.drawn.close();
    });
    remove(&session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{codec::TileHeader, platform::tests::{FakeScreen, FAKE}};

    #[test]
    fn frame_packets_carry_header_and_payload() {
        let header = HostMsg::Frame { seq: 3, width: 10, height: 10, tiles: vec![TileHeader { x: 0, y: 0, w: 10, h: 10, len: 3 }], bytes: 3 };
        let packet = frame_packet(&header, &[7, 8, 9]);
        assert_eq!(packet[0], 1);
        let len = u32::from_be_bytes(packet[1..5].try_into().unwrap()) as usize;
        let parsed: HostMsg = serde_json::from_slice(&packet[5..5 + len]).unwrap();
        assert_eq!(parsed, header);
        assert_eq!(&packet[5 + len..], &[7, 8, 9]);
    }

    /// Two paired BridgeLink nodes over loopback QUIC; the host shares a fake screen.
    /// Host settings and the fake screen are process-wide.
    static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn a_paired_device_views_and_controls_the_screen() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let fake = FakeScreen::default();
        *FAKE.lock().unwrap() = Some(fake.clone());
        let (viewer, _host, host_id) = crate::bridgelink::peer::tests::paired_pair();

        let (events_tx, events_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let session = tauri::async_runtime::block_on(connect(&viewer, &host_id, ViewerMsg::Hello { monitor: 0, max_width: 1920, quality: 70 }, move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = events_tx.send(bytes);
            }
        }))
        .unwrap();

        let next = || events_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let ready = next();
        assert_eq!(ready[0], 0);
        assert!(String::from_utf8_lossy(&ready[1..]).contains("\"Fake\""));
        assert_eq!(crate::remote::host::status().sessions.len(), 1, "the host shows the session");

        // First frame: the whole screen as one JPEG.
        let first = next();
        assert_eq!(first[0], 1);
        let len = u32::from_be_bytes(first[1..5].try_into().unwrap()) as usize;
        let HostMsg::Frame { width, tiles, bytes, .. } = serde_json::from_slice::<HostMsg>(&first[5..5 + len]).unwrap() else { panic!() };
        assert_eq!((width, tiles.len()), (320, 1));
        assert_eq!(first.len() - 5 - len, bytes as usize);

        // Drawn: the next frame only carries the tiles the moving square touched.
        remote_frame_drawn(session.clone()).unwrap();
        let second = next();
        let len = u32::from_be_bytes(second[1..5].try_into().unwrap()) as usize;
        let HostMsg::Frame { tiles, .. } = serde_json::from_slice::<HostMsg>(&second[5..5 + len]).unwrap() else { panic!() };
        assert!(!tiles.is_empty() && tiles.iter().all(|t| t.w <= 128), "{tiles:?}");

        // Input reaches the host's injector.
        remote_input(session.clone(), vec![InputEvent::Move { x: 0.5, y: 0.5 }, InputEvent::Key { key: "a".into(), down: true }]).unwrap();
        for _ in 0..100 {
            if fake.input.lock().unwrap().len() >= 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(fake.input.lock().unwrap()[1], (0, InputEvent::Key { key: "a".into(), down: true }));

        // Stop on the host: the viewer hears why, and the session is gone on both sides.
        crate::remote::host::stop_all();
        remote_frame_drawn(session.clone()).unwrap();
        let ended = loop {
            let packet = next();
            if packet[0] == 0 {
                break String::from_utf8_lossy(&packet[1..]).to_string();
            }
            let _ = remote_frame_drawn(session.clone());
        };
        assert!(ended.contains("Stopped on"), "{ended}");
        for _ in 0..100 {
            if crate::remote::host::status().sessions.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(crate::remote::host::status().sessions.is_empty());
        *FAKE.lock().unwrap() = None;
    }

    #[test]
    fn refused_when_control_is_off() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (viewer, _host, host_id) = crate::bridgelink::peer::tests::paired_pair();
        // Settings are process-wide; this test only reads the refusal, then restores them.
        crate::remote::host::remote_host_settings(false, false);
        let error = tauri::async_runtime::block_on(connect(&viewer, &host_id, ViewerMsg::Hello { monitor: 0, max_width: 1920, quality: 70 }, |_| {})).unwrap_err();
        crate::remote::host::remote_host_settings(true, false);
        assert!(error.contains("turned off") || error.contains("can't be controlled"), "{error}");
    }
}
