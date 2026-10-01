//! Paired devices talking to each other over the encrypted link, and pairing itself.
//!
//! Pairing (numeric comparison with a commitment):
//! 1. The initiator connects without a pinned certificate and sends `Hello`.
//! 2. The responder answers `Commit` = H(its cert, initiator's cert, its nonce).
//! 3. The initiator sends its nonce; the responder reveals its nonce; the initiator checks the commitment.
//! 4. Both show the same six-digit code (from both certs and both nonces). Each person confirms on
//!    their own computer; only when both have, each side pins the other's certificate.
//!
//! A device in the middle sees different certificates on each side, so the codes differ unless it wins
//! a one-in-a-million guess, and each attempt is a visible pairing request.

use super::*;
use crate::link::{
    sas,
    transport::{read_frame, write_frame, BoxFuture, Caller, Handler, Request, Response},
};
use serde_json::json;

pub(super) const PAIRING_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);
const PEER_REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Requests that wait for a person on the other computer (Allow/Deny dialogs, a Contacts permission prompt).
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PairMessage {
    #[serde(rename_all = "camelCase")]
    Hello { instance_id: String, name: String, platform: String, api_port: u16 },
    #[serde(rename_all = "camelCase")]
    Commit { instance_id: String, name: String, platform: String, api_port: u16, commit: String },
    Nonce { nonce: String },
    Confirm { confirmed: bool },
    Final { paired: bool, detail: String },
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

async fn read_pair(recv: &mut quinn::RecvStream) -> Result<PairMessage, String> {
    match tokio::time::timeout(EXCHANGE_TIMEOUT, read_frame::<PairMessage>(recv)).await {
        Ok(result) => result,
        Err(_) => Err("The other computer stopped answering".into()),
    }
}

/// Stores a newly paired device (replacing an older pairing of the same device).
fn store_pairing(manager: &BridgeLinkManager, peer: PersistedPeer) -> Result<BridgeLinkPairedPeer, String> {
    let public = peer.public();
    let mut runtime = manager.lock()?;
    runtime.paired.insert(peer.instance_id.clone(), peer);
    if runtime.legacy.remove(&public.instance_id).is_some() {
        save_legacy(&runtime);
    }
    save_peers(&runtime)?;
    runtime.detail = Some(format!("Paired with {}", public.name));
    runtime.pair_results.push(BridgeLinkPairResult { paired: true, peer: Some(public.clone()), detail: format!("Paired with {}", public.name) });
    Ok(public)
}

fn finish_with(manager: &BridgeLinkManager, detail: String) {
    if let Ok(mut runtime) = manager.lock() {
        runtime.detail = Some(detail.clone());
        runtime.pair_results.push(BridgeLinkPairResult { paired: false, peer: None, detail });
    }
}

fn new_peer(instance_id: &str, name: &str, platform: &str, host: String, api_port: u16, fingerprint: String) -> PersistedPeer {
    PersistedPeer {
        instance_id: instance_id.to_string(),
        name: clean_text(name, "BridgeDeck", 64),
        platform: clean_text(platform, "unknown", 16),
        host,
        api_port,
        fingerprint,
        localsend_port: 53317,
        syncthing_device_id: None,
        paired_at: now_ms(),
        mac_addresses: Vec::new(),
    }
}

/// Responder side of pairing.
async fn respond(manager: BridgeLinkManager, caller: Caller, hello: PairMessage, mut send: quinn::SendStream, mut recv: quinn::RecvStream) {
    let PairMessage::Hello { instance_id, name, platform, api_port } = hello else { return };
    // Decide under the lock, answer after releasing it (a lock guard can't be held across an await).
    let own = match manager.lock() {
        Ok(runtime) => {
            if instance_id == runtime.instance_id || clean_id(&instance_id).as_deref() != Some(instance_id.as_str()) {
                Err("Invalid pairing request")
            } else if runtime.incoming.len() >= MAX_PENDING {
                Err("Too many pairing requests are waiting")
            } else {
                Ok((runtime.fingerprint.clone(), runtime.instance_id.clone(), runtime.display_name.clone(), runtime.platform.clone(), runtime.api_port, runtime.app.clone()))
            }
        }
        Err(_) => return,
    };
    let own = match own {
        Ok(own) => own,
        Err(reason) => {
            let _ = write_frame(&mut send, &PairMessage::Final { paired: false, detail: reason.into() }).await;
            let _ = send.finish();
            return;
        }
    };
    let (own_fp, own_id, own_name, own_platform, own_port, app) = own;
    let nb = sas::nonce();
    let commit = hex(&sas::commitment(&own_fp, &caller.fingerprint, &nb));
    if write_frame(&mut send, &PairMessage::Commit { instance_id: own_id, name: own_name, platform: own_platform, api_port: own_port, commit }).await.is_err() {
        return;
    }
    let Ok(PairMessage::Nonce { nonce }) = read_pair(&mut recv).await else { return };
    let Some(na) = unhex(&nonce) else { return };
    if write_frame(&mut send, &PairMessage::Nonce { nonce: hex(&nb) }).await.is_err() {
        return;
    }
    let code = sas::code(&caller.fingerprint, &own_fp, &na, &nb);
    let request_id = Uuid::new_v4().to_string();
    let peer_name = clean_text(&name, "BridgeDeck", 64);
    let host = caller.address.ip().to_string();
    if let Ok(mut runtime) = manager.lock() {
        runtime.incoming.insert(request_id.clone(), PairingState {
            request_id: request_id.clone(),
            peer_instance_id: instance_id.clone(),
            peer_name: peer_name.clone(),
            peer_platform: clean_text(&platform, "unknown", 16),
            host: host.clone(),
            code,
            local: None,
            created_at: now_ms(),
        });
        runtime.detail = Some(format!("{peer_name} wants to pair: compare the code on both screens"));
    }
    if let Some(app) = &app {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title("Pairing request").body(format!("{peer_name} wants to pair with this computer. Open BridgeDeck to compare the code.")).show();
    }

    // Wait for both people: this computer's answer (UI) and the initiator's confirmation (stream).
    let deadline = Instant::now() + PAIRING_TIMEOUT;
    let mut remote: Option<bool> = None;
    let outcome = {
        let mut confirm = Box::pin(read_frame::<PairMessage>(&mut recv));
        loop {
            let local = manager.lock().ok().map(|r| r.incoming.get(&request_id).map(|p| p.local)).unwrap_or(None);
            let local = match local {
                Some(answer) => answer,
                None => break Err("The pairing request was dismissed".to_string()),
            };
            if local == Some(false) {
                break Err(format!("Pairing with {peer_name} declined"));
            }
            if remote == Some(false) {
                break Err(format!("{peer_name} cancelled pairing"));
            }
            if local == Some(true) && remote == Some(true) {
                break Ok(());
            }
            if Instant::now() >= deadline {
                break Err("Pairing timed out".to_string());
            }
            tokio::select! {
                message = &mut confirm, if remote.is_none() => {
                    remote = Some(matches!(message, Ok(PairMessage::Confirm { confirmed: true })));
                }
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
        }
    };
    if let Ok(mut runtime) = manager.lock() {
        runtime.incoming.remove(&request_id);
    }
    match outcome {
        Ok(()) => {
            let stored = store_pairing(&manager, new_peer(&instance_id, &name, &platform, host, api_port, caller.fingerprint.clone()));
            let paired = stored.is_ok();
            let detail = stored.map(|p| format!("Paired with {}", p.name)).unwrap_or_else(|e| e);
            let _ = write_frame(&mut send, &PairMessage::Final { paired, detail }).await;
        }
        Err(detail) => {
            let _ = write_frame(&mut send, &PairMessage::Final { paired: false, detail: detail.clone() }).await;
            finish_with(&manager, detail);
        }
    }
    let _ = send.finish();
}

/// Initiator side of pairing (runs as an async task).
async fn initiate(manager: BridgeLinkManager, target: BridgeLinkPeer, request_id: String) -> Result<(), String> {
    let (link, own_fp, hello) = {
        let runtime = manager.lock()?;
        let link = runtime.link.clone().ok_or("BridgeLink is not running")?;
        let hello = PairMessage::Hello { instance_id: runtime.instance_id.clone(), name: runtime.display_name.clone(), platform: runtime.platform.clone(), api_port: runtime.api_port };
        (link, runtime.fingerprint.clone(), hello)
    };
    let address = (target.host.as_str(), target.api_port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .find(SocketAddr::is_ipv4)
        .ok_or("Could not resolve the other computer")?;
    let (connection, peer_fp) = link.connect(&[address], None).await?;
    let (mut send, mut recv) = connection.open_bi().await.map_err(|e| e.to_string())?;
    let body = serde_json::to_string(&hello).map_err(|e| e.to_string())?;
    write_frame(&mut send, &Request { method: "POST".into(), path: "/pair".into(), body }).await?;
    let (name, platform, api_port, commit) = match read_pair(&mut recv).await? {
        PairMessage::Commit { name, platform, api_port, commit, .. } => (name, platform, api_port, commit),
        PairMessage::Final { detail, .. } => return Err(detail),
        _ => return Err("Unexpected pairing message".into()),
    };
    let na = sas::nonce();
    write_frame(&mut send, &PairMessage::Nonce { nonce: hex(&na) }).await?;
    let PairMessage::Nonce { nonce } = read_pair(&mut recv).await? else { return Err("Unexpected pairing message".into()) };
    let nb = unhex(&nonce).ok_or("Invalid pairing message")?;
    if hex(&sas::commitment(&peer_fp, &own_fp, &nb)) != commit {
        return Err("Security check failed: the other side changed its answer. Pairing stopped.".into());
    }
    let code = sas::code(&own_fp, &peer_fp, &na, &nb);
    {
        let mut runtime = manager.lock()?;
        match runtime.outgoing.as_mut() {
            Some((state, status)) if state.request_id == request_id => {
                state.code = code;
                *status = "confirm".into();
            }
            _ => return Err("Pairing was cancelled".into()),
        }
    }

    let deadline = Instant::now() + PAIRING_TIMEOUT;
    let mut sent = false;
    let mut result = Box::pin(read_frame::<PairMessage>(&mut recv));
    let final_message = loop {
        if !sent {
            let local = manager.lock().ok().and_then(|r| r.outgoing.as_ref().filter(|(s, _)| s.request_id == request_id).map(|(s, _)| s.local));
            let local = match local {
                Some(answer) => answer,
                None => Some(false), // cancelled in the UI
            };
            if let Some(confirmed) = local {
                // If the other side already answered (declined) and closed, the write fails; its answer
                // is still waiting to be read below, and it says why.
                let written = write_frame(&mut send, &PairMessage::Confirm { confirmed }).await;
                sent = true;
                if let Err(error) = written {
                    return match tokio::time::timeout(Duration::from_secs(2), &mut result).await {
                        Ok(Ok(PairMessage::Final { detail, .. })) => Err(detail),
                        _ => Err(error),
                    };
                }
                if !confirmed {
                    let _ = send.finish();
                    return Err("Pairing cancelled".into());
                }
                if let Ok(mut runtime) = manager.lock() {
                    if let Some((_, status)) = runtime.outgoing.as_mut() {
                        *status = "waiting".into();
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            return Err("Pairing timed out".into());
        }
        tokio::select! {
            message = &mut result => break message?,
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    };
    let _ = send.finish();
    match final_message {
        PairMessage::Final { paired: true, .. } if sent => {
            store_pairing(&manager, new_peer(&target.instance_id, &name, &platform, target.host.clone(), api_port, peer_fp))?;
            Ok(())
        }
        PairMessage::Final { detail, .. } => Err(detail),
        _ => Err("Unexpected pairing message".into()),
    }
}

pub(super) struct PeerHandler {
    pub(super) manager: BridgeLinkManager,
}

impl Handler for PeerHandler {
    fn stream_paths(&self) -> &'static [&'static str] {
        &["/pair", crate::remote::SESSION_PATH, crate::clipboard::PATH]
    }

    fn stream(&self, caller: Caller, request: Request, mut send: quinn::SendStream, recv: quinn::RecvStream) -> BoxFuture {
        let manager = self.manager.clone();
        Box::pin(async move {
            if request.path == crate::remote::SESSION_PATH {
                // Only a paired device, identified by the certificate it proved, may control this computer.
                let found = manager.lock().ok().map(|r| (r.paired.values().find(|p| p.fingerprint == caller.fingerprint).cloned(), r.app.clone(), r.display_name.clone()));
                match found {
                    Some((Some(peer), app, host_name)) => crate::remote::host::serve(app, peer.instance_id, peer.name, host_name, send, recv).await,
                    _ => {
                        let _ = write_frame(&mut send, &crate::remote::HostMsg::Ended { reason: "This device is not paired with this computer".into() }).await;
                        let _ = send.finish();
                    }
                }
                return;
            }
            if request.path == crate::clipboard::PATH {
                let peer = manager.lock().ok().and_then(|r| r.paired.values().find(|p| p.fingerprint == caller.fingerprint).cloned());
                match peer {
                    Some(peer) => crate::clipboard::serve(peer.name, request.body, send, recv).await,
                    None => {
                        let _ = write_frame(&mut send, &json!({ "ok": false, "error": "This device is not paired with this computer" })).await;
                        let _ = send.finish();
                    }
                }
                return;
            }
            if let Ok(hello) = serde_json::from_str::<PairMessage>(&request.body) {
                respond(manager, caller, hello, send, recv).await;
            }
        })
    }

    fn handle(&self, caller: Caller, request: Request) -> Response {
        let manager = &self.manager;
        let peer = {
            let Ok(mut runtime) = manager.lock() else { return Response::json(500, r#"{"ok":false,"error":"state unavailable"}"#) };
            let Some(peer) = runtime.paired.values().find(|p| p.fingerprint == caller.fingerprint).cloned() else {
                return Response::json(401, r#"{"ok":false,"error":"This device is not paired with this computer"}"#);
            };
            // The device just proved its identity from this address, so it is reachable there.
            let host = caller.address.ip().to_string();
            if host != peer.host {
                discovery::record_seen(&mut runtime, &peer.instance_id, &host, is_tailscale_host(&host), now_ms());
            }
            peer
        };
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/status") => match manager.lock() {
                Ok(runtime) => Response::json(200, status_body(&runtime)),
                Err(_) => Response::json(500, "{}"),
            },
            ("POST", "/ai/inbox") => receive_ai(manager, &peer, &request.body),
            ("POST", "/ai/state") => match workspace::receive(manager, &peer.instance_id, &peer.name, &request.body) {
                Ok(()) => Response::json(202, r#"{"ok":true}"#),
                Err(error) => Response::json(400, json!({ "ok": false, "error": error }).to_string()),
            },
            ("POST", "/messages") => match serde_json::from_str::<crate::imessage::Op>(&request.body) {
                Ok(op) => match crate::imessage::handle(op) {
                    Ok(value) => Response::json(200, json!({ "ok": true, "result": value }).to_string()),
                    Err(error) => Response::json(409, json!({ "ok": false, "error": error }).to_string()),
                },
                Err(_) => Response::json(400, r#"{"ok":false,"error":"Invalid Messages request"}"#),
            },
            ("POST", "/contacts/save") => receive_contact_save(manager, &peer, &request.body),
            ("POST", "/upgrade/request") => {
                let Ok(req) = serde_json::from_str::<UpgradeRequest>(&request.body) else {
                    return Response::json(400, r#"{"ok":false,"error":"Invalid upgrade request"}"#);
                };
                let Some(app) = manager.lock().ok().and_then(|r| r.app.clone()) else { return Response::json(500, "{}") };
                match handle_upgrade_request(&app, &peer.name, &req) {
                    Ok(()) => Response::json(202, r#"{"ok":true}"#),
                    Err(error) => Response::json(409, json!({ "ok": false, "error": error }).to_string()),
                }
            }
            ("POST", "/notes/pull") => match super::notes::answer_pull(manager, &request.body) {
                Ok(body) => Response::json(200, body),
                Err(error) => Response::json(400, json!({ "ok": false, "error": error }).to_string()),
            },
            ("POST", "/notes/poke") => {
                // Pull its changes now, off the request thread.
                let (manager, id) = (manager.clone(), peer.instance_id.clone());
                thread::spawn(move || {
                    let _ = super::notes::pull_from(&manager, &id);
                });
                Response::json(202, r#"{"ok":true}"#)
            }
            ("GET", "/diagnostics") => match manager.lock().ok().and_then(|r| r.app.clone()) {
                Some(app) => Response::json(200, json!({ "ok": true, "report": crate::diagnostics::local_report(&app) }).to_string()),
                None => Response::json(200, r#"{"ok":false,"error":"not ready"}"#),
            },
            ("GET", "/upgrade/status") => match manager.lock().ok().and_then(|r| r.app.clone()) {
                Some(app) => Response::json(200, json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "status": crate::upgrade::read_status(&app) }).to_string()),
                None => Response::json(200, r#"{"ok":false,"error":"not ready"}"#),
            },
            _ => Response::json(404, r#"{"ok":false,"error":"Not found"}"#),
        }
    }
}

/// Paired device -> this computer: a relay message. The sender is the paired device that proved its
/// certificate, never a name taken from the message.
fn receive_ai(manager: &BridgeLinkManager, peer: &PersistedPeer, body: &str) -> Response {
    let Ok(wire) = serde_json::from_str::<AiInboxWire>(body) else {
        return Response::json(400, r#"{"ok":false,"error":"Invalid AI message"}"#);
    };
    if let Err(error) = validate_ai_body(&wire.body) {
        return Response::json(400, json!({ "ok": false, "error": error }).to_string());
    }
    let Ok(mut runtime) = manager.lock() else { return Response::json(500, "{}") };
    // Queued messages can arrive twice (a retry after a lost answer); keep one.
    if clean_id(&wire.id).is_some_and(|id| runtime.ai_messages.iter().any(|m| m.id == id)) {
        return Response::json(202, r#"{"ok":true}"#);
    }
    let message = AiMessage {
        id: clean_id(&wire.id).unwrap_or_else(|| Uuid::new_v4().to_string()),
        channel: clean_label(&wire.channel, DEFAULT_AI_CHANNEL),
        author: clean_label(&wire.author, "agent"),
        body: wire.body,
        reply_to: wire.reply_to.as_deref().and_then(clean_id),
        direction: "in".into(),
        peer_instance_id: peer.instance_id.clone(),
        peer_name: peer.name.clone(),
        created_at: now_ms(),
        pending: false,
        to: wire.to.iter().take(20).map(|t| clean_label(t, "agent")).collect(),
        room: wire.room.as_deref().and_then(clean_id),
    };
    let notify = runtime.app.clone().map(|app| (app, message.clone()));
    record_ai_message(&mut runtime, message);
    drop(runtime);
    if let Some((app, message)) = notify {
        notify_ai_message(&app, &message);
    }
    Response::json(202, r#"{"ok":true}"#)
}

/// One request to a paired device over the encrypted link.
fn peer_request(manager: &BridgeLinkManager, instance_id: &str, method: &str, path: &str, body: String, timeout: Duration) -> Result<(PersistedPeer, Response), String> {
    let (link, peer, addresses) = {
        let runtime = manager.lock()?;
        let link = runtime.link.clone().ok_or("BridgeLink is not running")?;
        let peer = runtime.paired.get(instance_id).cloned().ok_or("Paired computer not found")?;
        let addresses = peer_addresses(&runtime, &peer);
        (link, peer, addresses)
    };
    let request = Request { method: method.into(), path: path.into(), body };
    let response = link.request_blocking(&addresses, &peer.fingerprint, &request, timeout)?;
    Ok((peer, response))
}

fn response_error(peer: &PersistedPeer, response: &Response) -> String {
    let value: serde_json::Value = serde_json::from_str(&response.body).unwrap_or(serde_json::Value::Null);
    if response.status == 404 {
        return format!("{} can't do this yet (update BridgeDeck there)", peer.name);
    }
    value.get("error").and_then(|v| v.as_str()).map(str::to_string).unwrap_or_else(|| format!("{} answered with an error ({})", peer.name, response.status))
}

pub(super) enum Delivery {
    /// The device couldn't be reached; worth retrying later.
    Unreachable(String),
    /// The device answered and refused; retrying won't help.
    Rejected(String),
}

pub(super) fn deliver_ai(manager: &BridgeLinkManager, instance_id: &str, wire: &AiInboxWire) -> Result<(), Delivery> {
    let body = serde_json::to_string(wire).map_err(|e| Delivery::Rejected(e.to_string()))?;
    match peer_request(manager, instance_id, "POST", "/ai/inbox", body, PEER_REQUEST_TIMEOUT) {
        Ok((_, response)) if (200..300).contains(&response.status) => Ok(()),
        Ok((peer, response)) => Err(Delivery::Rejected(response_error(&peer, &response))),
        Err(error) if error.contains("not found") || error.contains("not running") => Err(Delivery::Rejected(error)),
        Err(error) => Err(Delivery::Unreachable(error)),
    }
}

/// A Messages request to the paired Mac (see `crate::imessage`).
pub fn forward_messages(manager: &BridgeLinkManager, instance_id: &str, op: serde_json::Value) -> Result<serde_json::Value, String> {
    let (peer, response) = peer_request(manager, instance_id, "POST", "/messages", op.to_string(), Duration::from_secs(30))?;
    let mut value: serde_json::Value = serde_json::from_str(&response.body).unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&response.status) || value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(response_error(&peer, &response));
    }
    Ok(value["result"].take())
}

/// A paired computer's notes changed after `since` (see `super::notes`).
pub(super) fn pull_notes(manager: &BridgeLinkManager, instance_id: &str, since: u64) -> Result<super::notes::PullAnswer, String> {
    let body = json!({ "since": since }).to_string();
    let (peer, response) = peer_request(manager, instance_id, "POST", "/notes/pull", body, Duration::from_secs(20))?;
    if response.status != 200 {
        return Err(response_error(&peer, &response));
    }
    serde_json::from_str(&response.body).map_err(|e| format!("Invalid notes answer: {e}"))
}

/// Tells a paired computer this one's notes changed.
pub(super) fn poke_notes(manager: &BridgeLinkManager, instance_id: &str) -> Result<(), String> {
    peer_request(manager, instance_id, "POST", "/notes/poke", String::new(), PEER_REQUEST_TIMEOUT).map(|_| ())
}

/// A paired computer's own diagnostics report (see `crate::diagnostics`).
pub fn peer_diagnostics(manager: &BridgeLinkManager, instance_id: &str) -> Result<String, String> {
    let (peer, response) = peer_request(manager, instance_id, "GET", "/diagnostics", String::new(), Duration::from_secs(15))?;
    let value: serde_json::Value = serde_json::from_str(&response.body).unwrap_or(serde_json::Value::Null);
    match value.get("report").and_then(|v| v.as_str()) {
        Some(report) if response.status == 200 => Ok(report.to_string()),
        _ => Err(response_error(&peer, &response)),
    }
}

/// Every paired device: (instance ID, name).
pub fn paired_peers(manager: &BridgeLinkManager) -> Vec<(String, String)> {
    manager.lock().map(|runtime| runtime.paired.values().map(|p| (p.instance_id.clone(), p.name.clone())).collect()).unwrap_or_default()
}

/// What a long-lived stream to a paired device needs: the link, its addresses and its pinned certificate.
pub fn link_to(manager: &BridgeLinkManager, instance_id: &str) -> Result<(Arc<Link>, Vec<SocketAddr>, String), String> {
    let runtime = manager.lock()?;
    let link = runtime.link.clone().ok_or("BridgeLink is not running")?;
    let peer = runtime.paired.get(instance_id).ok_or("Paired computer not found")?;
    Ok((link, peer_addresses(&runtime, peer), peer.fingerprint.clone()))
}

/// Sends this device's workspace view to a paired device (see `workspace::push`).
pub(super) fn push_workspace(manager: &BridgeLinkManager, instance_id: &str, body: String) -> Result<(), String> {
    let (peer, response) = peer_request(manager, instance_id, "POST", "/ai/state", body, PEER_REQUEST_TIMEOUT)?;
    if (200..300).contains(&response.status) { Ok(()) } else { Err(response_error(&peer, &response)) }
}

/// Fetches a paired device's status and updates what it advertises (address details, IDs).
fn fetch_peer_status(manager: &BridgeLinkManager, instance_id: &str) -> Result<(serde_json::Value, BridgeLinkPairedPeer), String> {
    let (peer, response) = peer_request(manager, instance_id, "GET", "/status", String::new(), PEER_REQUEST_TIMEOUT)?;
    if response.status != 200 {
        return Err(response_error(&peer, &response));
    }
    let value: serde_json::Value = serde_json::from_str(&response.body).map_err(|e| e.to_string())?;
    let mut runtime = manager.lock()?;
    let stored = runtime.paired.get_mut(instance_id).ok_or("Paired computer disappeared")?;
    let text = |key: &str| value.get(key).and_then(|v| v.as_str()).filter(|v| !v.trim().is_empty()).map(str::to_string);
    if let Some(name) = text("hostname") {
        stored.name = clean_text(&name, &stored.name, 64);
    }
    if let Some(port) = value.get("localsendPort").and_then(|v| v.as_u64()).and_then(|v| u16::try_from(v).ok()) {
        stored.localsend_port = port;
    }
    if let Some(id) = text("syncthingDeviceId") {
        stored.syncthing_device_id = Some(id);
    }
    if let Some(macs) = value.get("macAddresses").and_then(|v| v.as_array()) {
        let macs: Vec<String> = macs.iter().filter_map(|m| m.as_str()).filter(|m| crate::wake::parse_mac(m).is_some()).take(8).map(str::to_string).collect();
        if !macs.is_empty() {
            stored.mac_addresses = macs;
        }
    }
    // Present-or-absent on every refresh: the server can be stopped or started at any time.
    let public = stored.public();
    save_peers(&runtime)?;
    Ok((value, public))
}

/// Sends the Wake-on-LAN packet for a paired computer that's asleep.
#[tauri::command]
pub async fn bridgelink_wake(instance_id: String, manager: State<'_, BridgeLinkManager>) -> Result<String, String> {
    let (name, macs, addresses) = {
        let runtime = manager.lock()?;
        let peer = runtime.paired.get(&instance_id).ok_or("Paired computer not found")?;
        (peer.name.clone(), peer.mac_addresses.clone(), peer_addresses(&runtime, peer))
    };
    crate::wake::send(&macs, &addresses)?;
    Ok(format!("Wake-up sent to {name}. It can take half a minute to come back."))
}

#[tauri::command]
pub async fn bridgelink_refresh_peer(instance_id: String, manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkPairResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_, peer) = fetch_peer_status(&manager, &instance_id)?;
        Ok(BridgeLinkPairResult { paired: true, peer: Some(peer), detail: "Paired computer metadata refreshed".into() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A paired device's live status (uptime, memory, version), in the same shape as `/status`.
#[tauri::command]
pub async fn bridgelink_peer_status(instance_id: String, manager: State<'_, BridgeLinkManager>) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match fetch_peer_status(&manager, &instance_id) {
        Ok((value, _)) => Ok(value),
        Err(error) => Ok(json!({ "ok": false, "error": error })),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn bridgelink_request_pair(peer_instance_id: String, manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkStatus, String> {
    let manager = manager.inner().clone();
    let (target, request_id) = {
        let mut runtime = manager.lock()?;
        let target = runtime.discovered.get(&peer_instance_id).cloned().ok_or("That computer is no longer visible")?;
        if target.protocol < PROTOCOL_VERSION {
            return Err(format!("{} runs an older BridgeDeck; update it before pairing", target.name));
        }
        if runtime.outgoing.as_ref().is_some_and(|(_, status)| status != "failed") {
            return Err("Another pairing is in progress".into());
        }
        let request_id = Uuid::new_v4().to_string();
        runtime.outgoing = Some((
            PairingState {
                request_id: request_id.clone(),
                peer_instance_id: target.instance_id.clone(),
                peer_name: target.name.clone(),
                peer_platform: target.platform.clone(),
                host: target.host.clone(),
                code: String::new(),
                local: None,
                created_at: now_ms(),
            },
            "connecting".into(),
        ));
        runtime.detail = Some(format!("Connecting securely to {}", target.name));
        (target, request_id)
    };
    let task_manager = manager.clone();
    let task_id = request_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = initiate(task_manager.clone(), target, task_id.clone()).await;
        if let Ok(mut runtime) = task_manager.lock() {
            if runtime.outgoing.as_ref().is_some_and(|(s, _)| s.request_id == task_id) {
                runtime.outgoing = None;
            }
        }
        if let Err(error) = result {
            finish_with(&task_manager, error);
        }
    });
    let mut runtime = manager.lock()?;
    Ok(snapshot(&mut runtime))
}

/// This computer's person compared the codes on an outgoing pairing: `true` = they match.
#[tauri::command]
pub fn bridgelink_confirm_pair(confirm: bool, manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkStatus, String> {
    let mut runtime = manager.lock()?;
    let (state, _) = runtime.outgoing.as_mut().ok_or("No pairing in progress")?;
    if state.code.is_empty() && confirm {
        return Err("The code isn't ready yet".into());
    }
    state.local = Some(confirm);
    Ok(snapshot(&mut runtime))
}

/// Finished pairings (either side) the UI hasn't shown yet.
#[tauri::command]
pub fn bridgelink_poll_pair(manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkPairResult, String> {
    let mut runtime = manager.lock()?;
    if !runtime.pair_results.is_empty() {
        return Ok(runtime.pair_results.remove(0));
    }
    let detail = match runtime.outgoing.as_ref() {
        Some((state, status)) if status == "confirm" => format!("Compare the code {} with {}", state.code, state.peer_name),
        Some((state, status)) if status == "waiting" => format!("Waiting for {} to confirm", state.peer_name),
        Some((state, _)) => format!("Connecting securely to {}", state.peer_name),
        None => String::new(),
    };
    Ok(BridgeLinkPairResult { paired: false, peer: None, detail })
}

#[tauri::command]
pub fn bridgelink_approve(request_id: String, manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkPairResult, String> {
    let mut runtime = manager.lock()?;
    let pending = runtime.incoming.get_mut(&request_id).ok_or("Pair request is no longer pending")?;
    pending.local = Some(true);
    Ok(BridgeLinkPairResult { paired: false, peer: None, detail: format!("Waiting for {} to confirm the code", pending.peer_name) })
}

#[tauri::command]
pub fn bridgelink_decline(request_id: String, manager: State<'_, BridgeLinkManager>) -> Result<BridgeLinkStatus, String> {
    let mut runtime = manager.lock()?;
    if let Some(pending) = runtime.incoming.get_mut(&request_id) {
        pending.local = Some(false);
    }
    Ok(snapshot(&mut runtime))
}

/// A contact edit for the Mac's Contacts app. Only the listed values change: `*_remove` entries are
/// deleted by exact value, `*_add` entries are appended; everything else (and existing labels) is kept.
/// `person_id` is the Contacts identifier ("<UUID>:ABPerson"); empty = new contact.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContactSaveRequest {
    pub person_id: String,
    pub first_name: String,
    pub last_name: String,
    pub phones_add: Vec<String>,
    pub phones_remove: Vec<String>,
    pub emails_add: Vec<String>,
    pub emails_remove: Vec<String>,
}

impl ContactSaveRequest {
    pub fn validate(&self) -> Result<(), String> {
        let id_ok = self.person_id.is_empty()
            || (self.person_id.len() <= 80
                && self.person_id.ends_with(":ABPerson")
                && self.person_id.trim_end_matches(":ABPerson").chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        if !id_ok {
            return Err("Invalid contact id".into());
        }
        if self.first_name.trim().is_empty() && self.last_name.trim().is_empty() {
            return Err("A contact needs a first or last name".into());
        }
        let lists = [&self.phones_add, &self.phones_remove, &self.emails_add, &self.emails_remove];
        let too_long = |s: &String| s.chars().count() > 120 || s.contains('\n') || s.contains('\r');
        if self.first_name.chars().count() > 100 || self.last_name.chars().count() > 100
            || self.first_name.contains('\n') || self.last_name.contains('\n')
            || lists.iter().any(|l| l.len() > 20 || l.iter().any(too_long))
        {
            return Err("Contact fields are too long".into());
        }
        Ok(())
    }
}

/// Sends a contact edit to the paired Mac, which saves it in its Contacts app (synced via iCloud).
pub fn forward_contact_save(manager: &BridgeLinkManager, request: &ContactSaveRequest) -> Result<String, String> {
    request.validate()?;
    let mac = {
        let runtime = manager.lock()?;
        runtime.paired.values().find(|p| p.platform == "macos").map(|p| p.instance_id.clone()).ok_or("No paired Mac to save the contact on")?
    };
    let body = serde_json::to_string(request).map_err(|e| e.to_string())?;
    // Generous timeout: the first save waits for the user to allow Contacts access on the Mac.
    let (peer, response) = peer_request(manager, &mac, "POST", "/contacts/save", body, APPROVAL_TIMEOUT)?;
    let value: serde_json::Value = serde_json::from_str(&response.body).unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&response.status) || value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(response_error(&peer, &response));
    }
    Ok(value.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string())
}

/// Paired device -> this Mac: save a contact edit in the Contacts app. Rate limited, and the user on
/// this Mac approves each edit in a dialog.
fn receive_contact_save(manager: &BridgeLinkManager, peer: &PersistedPeer, body: &str) -> Response {
    if !cfg!(target_os = "macos") {
        return Response::json(404, r#"{"ok":false,"error":"Contacts are only editable on the Mac"}"#);
    }
    let Ok(req) = serde_json::from_str::<ContactSaveRequest>(body) else {
        return Response::json(400, r#"{"ok":false,"error":"Invalid contact request"}"#);
    };
    if let Err(error) = req.validate().and_then(|_| reserve_contact_edit(manager)) {
        return Response::json(409, json!({ "ok": false, "error": error }).to_string());
    }
    let app = manager.lock().ok().and_then(|r| r.app.clone());
    let approved = app.as_ref().is_some_and(|app| confirm_remote_contact_edit(app, &peer.name, &req));
    let result = if approved { crate::save_apple_contact(&req) } else { Err("The change was not approved on the Mac".to_string()) };
    release_contact_edit(manager);
    match result {
        Ok(id) => Response::json(200, json!({ "ok": true, "id": id }).to_string()),
        Err(error) => Response::json(409, json!({ "ok": false, "error": error }).to_string()),
    }
}

/// Remote contact edits: one at a time, at most 10 per 10 minutes.
const CONTACT_EDIT_LIMIT: usize = 10;
const CONTACT_EDIT_WINDOW: Duration = Duration::from_secs(600);

fn reserve_contact_edit(manager: &BridgeLinkManager) -> Result<(), String> {
    let mut runtime = manager.lock()?;
    if runtime.contact_edit_busy {
        return Err("Another contact change is waiting for approval on the Mac".into());
    }
    let now = Instant::now();
    runtime.contact_edits.retain(|at| now.duration_since(*at) < CONTACT_EDIT_WINDOW);
    if runtime.contact_edits.len() >= CONTACT_EDIT_LIMIT {
        return Err("Too many contact changes; try again in a few minutes".into());
    }
    runtime.contact_edits.push(now);
    runtime.contact_edit_busy = true;
    Ok(())
}

fn release_contact_edit(manager: &BridgeLinkManager) {
    if let Ok(mut runtime) = manager.lock() {
        runtime.contact_edit_busy = false;
    }
}

/// Asks the user on this computer to approve a contact change requested by the paired computer.
/// Denies after 60 s without an answer.
fn confirm_remote_contact_edit(app: &AppHandle, peer_name: &str, req: &ContactSaveRequest) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let name = format!("{} {}", req.first_name.trim(), req.last_name.trim()).trim().to_string();
    let mut lines = vec![format!("{peer_name} wants to {} “{name}” in Contacts.", if req.person_id.is_empty() { "create" } else { "change" })];
    let list = |label: &str, values: &[String], lines: &mut Vec<String>| if !values.is_empty() { lines.push(format!("{label}: {}", values.join(", "))) };
    list("Add phone", &req.phones_add, &mut lines);
    list("Remove phone", &req.phones_remove, &mut lines);
    list("Add email", &req.emails_add, &mut lines);
    list("Remove email", &req.emails_remove, &mut lines);
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(lines.join("\n"))
        .title("Allow contact change?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Deny".into()))
        .show(move |allowed| { let _ = tx.send(allowed); });
    rx.recv_timeout(Duration::from_secs(60)).unwrap_or(false)
}

/// What the paired computer asks for in `POST /upgrade/request`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpgradeRequest {
    /// "git" (default) or "source".
    pub mode: String,
    /// Source mode: bundle name in the receive folder, and its SHA-256.
    pub file_name: String,
    pub sha256: String,
    /// Sender's BridgeDeck version, shown in the approval dialog.
    pub from_version: String,
}

static UPGRADE_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

fn handle_upgrade_request(app: &AppHandle, peer_name: &str, req: &UpgradeRequest) -> Result<(), String> {
    use crate::upgrade::UpgradeMode;
    let mode = match req.mode.as_str() { "" | "git" => UpgradeMode::Git, "source" => UpgradeMode::Source, _ => return Err("Unknown upgrade mode".into()) };
    crate::upgrade::preflight(&mode)?;
    if crate::upgrade::is_running(app) {
        return Err("An upgrade is already running on this computer".into());
    }
    // Verify the bundle before asking, so the user only approves something that can run.
    let bundle = if mode == UpgradeMode::Source { Some(crate::upgrade::locate_received_bundle(app, &req.file_name, &req.sha256)?) } else { None };
    if UPGRADE_PROMPT_OPEN.swap(true, Ordering::SeqCst) {
        return Err("Another upgrade request is waiting for approval".into());
    }
    let approved = confirm_upgrade(app, peer_name, &mode, req);
    UPGRADE_PROMPT_OPEN.store(false, Ordering::SeqCst);
    if !approved {
        return Err("The upgrade was not approved on this computer".into());
    }
    crate::upgrade::start(app, mode, bundle, peer_name)
}

fn confirm_upgrade(app: &AppHandle, peer_name: &str, mode: &crate::upgrade::UpgradeMode, req: &UpgradeRequest) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let from = if req.from_version.trim().is_empty() { String::new() } else { format!(" (it runs v{})", req.from_version.trim()) };
    let what = match mode {
        crate::upgrade::UpgradeMode::Git => "pull the latest version from GitHub".to_string(),
        crate::upgrade::UpgradeMode::Source => format!("use {peer_name}'s own source code{from}, sent to this computer"),
    };
    let text = format!(
        "{peer_name} wants to upgrade BridgeDeck on this computer (now v{}): {what}, rebuild, reinstall and restart.\n\nThis takes several minutes; BridgeDeck restarts when it's done. Only allow this if you asked for it.",
        env!("CARGO_PKG_VERSION")
    );
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(text)
        .title("Allow BridgeDeck upgrade?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Deny".into()))
        .show(move |allowed| { let _ = tx.send(allowed); });
    rx.recv_timeout(Duration::from_secs(60)).unwrap_or(false)
}

/// Asks a paired computer to upgrade. Returns after the user there answers.
pub fn forward_upgrade_request(manager: &BridgeLinkManager, instance_id: &str, request: &UpgradeRequest) -> Result<(), String> {
    let body = serde_json::to_string(request).map_err(|e| e.to_string())?;
    let (peer, response) = peer_request(manager, instance_id, "POST", "/upgrade/request", body, APPROVAL_TIMEOUT)?;
    let value: serde_json::Value = serde_json::from_str(&response.body).unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&response.status) || value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(response_error(&peer, &response));
    }
    Ok(())
}

/// A paired computer's upgrade progress.
pub fn peer_upgrade_status(manager: &BridgeLinkManager, instance_id: &str) -> Result<serde_json::Value, String> {
    let (_, response) = peer_request(manager, instance_id, "GET", "/upgrade/status", String::new(), PEER_REQUEST_TIMEOUT)?;
    if response.status == 404 {
        return Ok(json!({ "ok": false, "error": "not supported" }));
    }
    serde_json::from_str(&response.body).map_err(|e| e.to_string())
}

/// Asks a device still on BridgeDeck 0.8 (paired the old way) to upgrade itself, so it can then be
/// paired securely. Uses the old plaintext protocol one last time; the device's user still has to
/// approve the upgrade there.
#[tauri::command]
pub async fn bridgelink_legacy_upgrade(instance_id: String, request: UpgradeRequest, manager: State<'_, BridgeLinkManager>) -> Result<(), String> {
    let legacy = manager.lock()?.legacy.get(&instance_id).cloned().ok_or("That device isn't waiting to be re-paired")?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Write};
        let body = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        let address = (legacy.host.as_str(), legacy.api_port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("Could not resolve the device")?;
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).map_err(|e| format!("Could not reach {}: {e}", legacy.name))?;
        stream.set_read_timeout(Some(APPROVAL_TIMEOUT)).map_err(|e| e.to_string())?;
        let request = format!(
            "POST /upgrade/request HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            format_host_port(&legacy.host, legacy.api_port), legacy.access_token, body.len()
        );
        stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
        let mut raw = String::new();
        stream.read_to_string(&mut raw).map_err(|e| e.to_string())?;
        let (head, body) = raw.split_once("\r\n\r\n").ok_or("Invalid answer")?;
        let status = head.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
        let value: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
        if status == 404 {
            return Err(format!("{} is too old to be upgraded remotely; update it by hand", legacy.name));
        }
        if !(200..300).contains(&status) || value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(value.get("error").and_then(|v| v.as_str()).map(str::to_string).unwrap_or_else(|| format!("{} answered HTTP {status}", legacy.name)));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::link::identity::Identity;

    /// A BridgeLink runtime with only the encrypted link running (no discovery, loopback API or app).
    fn node(name: &str) -> (BridgeLinkManager, u16) {
        let manager = BridgeLinkManager::default();
        let dir = std::env::temp_dir().join(format!("bd-node-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let identity = Identity::generate().unwrap();
        let link = Link::bind(0, identity.clone(), Arc::new(PeerHandler { manager: manager.clone() })).unwrap();
        let port = link.local_port().unwrap();
        {
            let mut runtime = manager.lock().unwrap();
            runtime.running = true;
            runtime.instance_id = Uuid::new_v4().to_string();
            runtime.display_name = name.into();
            runtime.api_port = port;
            runtime.fingerprint = identity.fingerprint;
            runtime.storage_dir = Some(dir);
            runtime.link = Some(link);
        }
        (manager, port)
    }

    fn discover(from: &BridgeLinkManager, to: &BridgeLinkManager, port: u16) -> String {
        let to = to.lock().unwrap();
        let peer = BridgeLinkPeer {
            instance_id: to.instance_id.clone(), name: to.display_name.clone(), platform: "linux".into(),
            host: "127.0.0.1".into(), api_port: port, protocol: 2, via: "lan".into(), last_seen: now_ms(),
        };
        from.lock().unwrap().discovered.insert(peer.instance_id.clone(), peer);
        to.instance_id.clone()
    }

    fn start_pairing(a: &BridgeLinkManager, b_id: &str) {
        let target = a.lock().unwrap().discovered[b_id].clone();
        let request_id = Uuid::new_v4().to_string();
        a.lock().unwrap().outgoing = Some((
            PairingState { request_id: request_id.clone(), peer_instance_id: b_id.into(), peer_name: target.name.clone(), peer_platform: "linux".into(), host: target.host.clone(), code: String::new(), local: None, created_at: now_ms() },
            "connecting".into(),
        ));
        let task = a.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = initiate(task.clone(), target, request_id).await {
                finish_with(&task, error);
            }
            task.lock().unwrap().outgoing = None;
        });
    }

    fn wait_for<T>(mut check: impl FnMut() -> Option<T>) -> T {
        for _ in 0..200 {
            if let Some(value) = check() {
                return value;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("timed out");
    }

    #[test]
    fn pairing_shows_matching_codes_and_pins_certificates() {
        let (a, _) = node("A");
        let (b, b_port) = node("B");
        let b_id = discover(&a, &b, b_port);
        start_pairing(&a, &b_id);

        let a_code = wait_for(|| a.lock().unwrap().outgoing.as_ref().filter(|(_, s)| s == "confirm").map(|(p, _)| p.code.clone()));
        let (b_request, b_code) = wait_for(|| b.lock().unwrap().incoming.values().next().map(|p| (p.request_id.clone(), p.code.clone())));
        assert_eq!(a_code, b_code);
        assert_eq!(a_code.len(), 6);

        // Both people confirm, in either order.
        b.lock().unwrap().incoming.get_mut(&b_request).unwrap().local = Some(true);
        a.lock().unwrap().outgoing.as_mut().unwrap().0.local = Some(true);

        wait_for(|| (!a.lock().unwrap().paired.is_empty() && !b.lock().unwrap().paired.is_empty()).then_some(()));
        let (a_fp, b_fp) = (a.lock().unwrap().fingerprint.clone(), b.lock().unwrap().fingerprint.clone());
        assert_eq!(a.lock().unwrap().paired.values().next().unwrap().fingerprint, b_fp);
        assert_eq!(b.lock().unwrap().paired.values().next().unwrap().fingerprint, a_fp);
        assert!(a.lock().unwrap().pair_results.iter().any(|r| r.paired));

        // Paired: status and relay messages work in both directions.
        let (value, _) = fetch_peer_status(&a, &b_id).unwrap();
        assert_eq!(value["hostname"], "B");
        assert_eq!(value["protocol"], 2);
        let wire = AiInboxWire { id: "m1".into(), channel: "c".into(), author: "claude-a".into(), body: "hello".into(), reply_to: None, created_at: now_ms(), to: vec![], room: None };
        assert!(deliver_ai(&a, &b_id, &wire).is_ok());
        let received = b.lock().unwrap().ai_messages.clone();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].peer_name, "A");
        assert_eq!(received[0].direction, "in");
    }

    /// Pairs two nodes directly (as if both people had confirmed).
    fn pair_directly(a: &BridgeLinkManager, a_port: u16, b: &BridgeLinkManager, b_port: u16) -> (String, String) {
        let (a_id, a_name, a_fp) = { let r = a.lock().unwrap(); (r.instance_id.clone(), r.display_name.clone(), r.fingerprint.clone()) };
        let (b_id, b_name, b_fp) = { let r = b.lock().unwrap(); (r.instance_id.clone(), r.display_name.clone(), r.fingerprint.clone()) };
        a.lock().unwrap().paired.insert(b_id.clone(), new_peer(&b_id, &b_name, "linux", "127.0.0.1".into(), b_port, b_fp));
        b.lock().unwrap().paired.insert(a_id.clone(), new_peer(&a_id, &a_name, "linux", "127.0.0.1".into(), a_port, a_fp));
        (a_id, b_id)
    }

    /// Two running nodes paired with each other: (a, b, b's instance id).
    pub(crate) fn paired_pair() -> (BridgeLinkManager, BridgeLinkManager, String) {
        let (a, a_port) = node("A");
        let (b, b_port) = node("B");
        let (_, b_id) = pair_directly(&a, a_port, &b, b_port);
        (a, b, b_id)
    }

    #[test]
    fn notes_sync_both_ways_over_the_link() {
        let (a, a_port) = node("Mac");
        let (b, b_port) = node("Windows");
        let (a_id, b_id) = pair_directly(&a, a_port, &b, b_port);
        // A checklist made on the Mac shows up on Windows after one pull.
        let list = a.lock().unwrap().notes.create("list", "Home", "mac", now_ms()).unwrap();
        assert_eq!(super::notes::pull_from(&b, &a_id).unwrap(), 1);
        let on_b = b.lock().unwrap().notes.list();
        assert_eq!((on_b.len(), on_b[0].id.as_str(), on_b[0].folder.as_str()), (1, list.id.as_str(), "Home"));
        // Windows ticks the item; the Mac pulls the change back. Pulling again brings nothing new.
        let mut edited = on_b[0].clone();
        edited.blocks[0].text = "milk".into();
        edited.blocks[0].checked = true;
        b.lock().unwrap().notes.save_from_ui(edited, "win", now_ms() + 1).unwrap();
        assert_eq!(super::notes::pull_from(&a, &b_id).unwrap(), 1);
        let block = a.lock().unwrap().notes.list()[0].blocks[0].clone();
        assert_eq!((block.text.as_str(), block.checked), ("milk", true));
        assert_eq!(super::notes::pull_from(&a, &b_id).unwrap(), 0);
        assert_eq!(super::notes::pull_from(&b, &a_id).unwrap(), 0);
    }

    #[test]
    fn workspace_and_addressed_messages_reach_every_paired_device() {
        let (a, a_port) = node("Mac");
        let (b, b_port) = node("Windows");
        let (c, c_port) = node("Laptop");
        pair_directly(&a, a_port, &b, b_port);
        pair_directly(&a, a_port, &c, c_port);

        // An agent on the Mac opens a room and claims a file; both other devices see it.
        let room = {
            let mut runtime = a.lock().unwrap();
            let (id, name) = (runtime.instance_id.clone(), runtime.display_name.clone());
            runtime.workspace.hello("claude-mac", "", &id, &name, now_ms());
            runtime.workspace.claim("src/App.tsx", "claude-mac", None, &id, &name, now_ms()).unwrap();
            runtime.workspace.create_room("Ship it", "claude-mac", vec!["codex-win".into()], now_ms()).unwrap()
        };
        workspace::push(&a);
        for other in [&b, &c] {
            let state = other.lock().unwrap().workspace.state(now_ms());
            assert_eq!(state.rooms[0].id, room.id);
            assert_eq!(state.claims[0].agent, "claude-mac");
            assert_eq!(state.agents[0].device_name, "Mac", "named after the pairing");
        }
        // The claim holds on the other devices too.
        let error = b.lock().unwrap().workspace.claim("src/App.tsx", "codex-win", None, "w", "Windows", now_ms()).unwrap_err();
        assert!(error.contains("claude-mac"));

        // One send reaches both devices, addressed to one agent, in the room.
        let send = AiSendWire { author: "claude-mac".into(), body: "your turn".into(), channel: None, reply_to: None, peer_instance_id: None, to: vec!["codex-win".into()], room: Some(room.id.clone()) };
        let message = ai_send_internal(&a, send).unwrap();
        assert!(!message.pending);
        assert_eq!(message.peer_name, "Laptop, Windows");
        for other in [&b, &c] {
            let runtime = other.lock().unwrap();
            let received = &runtime.ai_messages[0];
            assert_eq!(received.to, vec!["codex-win"]);
            assert_eq!(received.room.as_deref(), Some(room.id.as_str()));
            assert!(workspace::is_for(received, "codex-win"));
            assert!(!workspace::is_for(received, "claude-win"));
        }
    }

    #[test]
    fn declining_on_either_side_pairs_nobody() {
        let (a, _) = node("A");
        let (b, b_port) = node("B");
        let b_id = discover(&a, &b, b_port);
        start_pairing(&a, &b_id);
        let b_request = wait_for(|| b.lock().unwrap().incoming.keys().next().cloned());
        a.lock().unwrap().outgoing.as_mut().unwrap().0.local = Some(true);
        b.lock().unwrap().incoming.get_mut(&b_request).unwrap().local = Some(false);
        let detail = wait_for(|| a.lock().unwrap().pair_results.first().map(|r| r.detail.clone()));
        assert!(detail.contains("declined"), "{detail}");
        assert!(a.lock().unwrap().paired.is_empty());
        assert!(b.lock().unwrap().paired.is_empty());
    }

    #[test]
    fn unpaired_devices_get_nothing() {
        let (a, _) = node("A");
        let (b, b_port) = node("B");
        let b_id = discover(&a, &b, b_port);
        // A believes it is paired with B, but B never paired with A: B must refuse.
        let b_fp = b.lock().unwrap().fingerprint.clone();
        a.lock().unwrap().paired.insert(b_id.clone(), new_peer(&b_id, "B", "linux", "127.0.0.1".into(), b_port, b_fp));
        let (_, response) = peer_request(&a, &b_id, "GET", "/status", String::new(), Duration::from_secs(5)).unwrap();
        assert_eq!(response.status, 401);
    }

    #[test]
    fn queued_messages_are_delivered_when_the_device_returns() {
        let (a, _) = node("A");
        let (b, b_port) = node("B");
        let b_id = discover(&a, &b, b_port);
        start_pairing(&a, &b_id);
        let b_request = wait_for(|| b.lock().unwrap().incoming.keys().next().cloned());
        b.lock().unwrap().incoming.get_mut(&b_request).unwrap().local = Some(true);
        wait_for(|| a.lock().unwrap().outgoing.as_ref().filter(|(_, s)| s == "confirm").map(|_| ()));
        a.lock().unwrap().outgoing.as_mut().unwrap().0.local = Some(true);
        wait_for(|| (!a.lock().unwrap().paired.is_empty()).then_some(()));

        // B goes away: point A at a closed port, then send.
        let real_port = a.lock().unwrap().paired[&b_id].api_port;
        a.lock().unwrap().paired.get_mut(&b_id).unwrap().api_port = 9;
        if let Some(link) = a.lock().unwrap().link.clone() {
            link.forget_all();
        }
        let message = ai_send_internal(&a, AiSendWire { author: "claude".into(), body: "later".into(), channel: None, reply_to: None, peer_instance_id: None, to: vec![], room: None }).unwrap();
        assert!(message.pending);
        assert_eq!(a.lock().unwrap().outbox.len(), 1);

        // B is back.
        a.lock().unwrap().paired.get_mut(&b_id).unwrap().api_port = real_port;
        flush_outbox(&a);
        assert!(a.lock().unwrap().outbox.is_empty());
        assert!(!a.lock().unwrap().ai_messages.iter().find(|m| m.id == message.id).unwrap().pending);
        assert!(b.lock().unwrap().ai_messages.iter().any(|m| m.body == "later"));
    }
}
