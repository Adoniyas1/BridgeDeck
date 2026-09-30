//! Finding devices: a UDP multicast announcement on the LAN every two seconds, and the same
//! announcement sent directly to each online Tailscale device (multicast doesn't cross Tailscale).
//! Announcements only say who is where; nothing is trusted until the encrypted link proves the
//! certificate pinned at pairing.

use super::*;
use std::net::UdpSocket;

pub(super) const DISCOVERY_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 77);
pub(super) const DISCOVERY_PORT: u16 = 41415;
pub(super) const PEER_STALE_MS: u64 = 12_000;
const PROTOCOL_V1: &str = "bridgedeck-link/1";
const PROTOCOL_V2: &str = "bridgedeck-link/2";
/// A LAN sighting this recent keeps a device on its LAN address even when it also shows up via Tailscale.
const LAN_PREFERENCE_MS: u64 = 15_000;
const SEEN_TTL_MS: u64 = 10 * 60_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryWire {
    protocol: String,
    instance_id: String,
    name: String,
    platform: String,
    api_port: u16,
}

pub(super) fn bind() -> Result<UdpSocket, String> {
    let udp = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)).map_err(|e| format!("Could not bind BridgeLink discovery UDP {DISCOVERY_PORT}: {e}"))?;
    udp.join_multicast_v4(&DISCOVERY_ADDR, &Ipv4Addr::UNSPECIFIED).map_err(|e| format!("Could not join the BridgeLink multicast group: {e}"))?;
    Ok(udp)
}

pub(super) fn spawn(socket: UdpSocket, manager: BridgeLinkManager, shutdown: Arc<AtomicBool>) {
    thread::spawn(move || {
        let _ = socket.set_read_timeout(Some(Duration::from_millis(450)));
        let _ = socket.set_multicast_ttl_v4(1);
        let _ = socket.set_multicast_loop_v4(true);
        let mut last_announce = Instant::now() - Duration::from_secs(10);
        let multicast = SocketAddr::new(IpAddr::V4(DISCOVERY_ADDR), DISCOVERY_PORT);
        let mut buffer = [0u8; 8192];
        while !shutdown.load(Ordering::Relaxed) {
            if last_announce.elapsed() >= Duration::from_secs(2) {
                let Ok(runtime) = manager.lock() else { break };
                let wire = DiscoveryWire {
                    protocol: PROTOCOL_V2.into(),
                    instance_id: runtime.instance_id.clone(),
                    name: runtime.display_name.clone(),
                    platform: runtime.platform.clone(),
                    api_port: runtime.api_port,
                };
                let targets = runtime.tailscale_targets.clone();
                drop(runtime);
                if let Ok(raw) = serde_json::to_vec(&wire) {
                    let _ = socket.send_to(&raw, multicast);
                    for ip in targets {
                        let _ = socket.send_to(&raw, SocketAddr::new(ip, DISCOVERY_PORT));
                    }
                }
                last_announce = Instant::now();
            }
            match socket.recv_from(&mut buffer) {
                Ok((count, addr)) => {
                    if let Ok(wire) = serde_json::from_slice::<DiscoveryWire>(&buffer[..count]) {
                        if let Ok(mut runtime) = manager.lock() {
                            observe(&mut runtime, wire, addr.ip(), now_ms());
                        }
                    }
                }
                Err(err) if matches!(err.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => thread::sleep(Duration::from_millis(150)),
            }
        }
    });
}

/// Records an announcement: the device's addresses, a paired device's current address, and the
/// discovered list.
fn observe(runtime: &mut Runtime, wire: DiscoveryWire, ip: IpAddr, now: u64) {
    let protocol = match wire.protocol.as_str() {
        PROTOCOL_V2 => 2,
        PROTOCOL_V1 => 1,
        _ => return,
    };
    if wire.instance_id == runtime.instance_id || clean_id(&wire.instance_id).as_deref() != Some(wire.instance_id.as_str()) {
        return;
    }
    let host = ip.to_string();
    let tailscale = is_tailscale_host(&host);
    record_seen(runtime, &wire.instance_id, &host, tailscale, now);

    if protocol == 2 {
        let lan_recent = runtime
            .seen
            .get(&wire.instance_id)
            .is_some_and(|seen| seen.iter().any(|(h, at, ts)| !ts && *h != host && now.saturating_sub(*at) < LAN_PREFERENCE_MS));
        // Keep a paired device reachable when DHCP (or a network change) hands it a new address.
        let moved = runtime.paired.get_mut(&wire.instance_id).is_some_and(|peer| {
            let prefer = !(tailscale && lan_recent);
            let changed = prefer && (peer.host != host || peer.api_port != wire.api_port);
            if changed {
                peer.host = host.clone();
                peer.api_port = wire.api_port;
            }
            changed
        });
        if moved {
            let _ = save_peers(runtime);
        }
    } else if let Some(legacy) = runtime.legacy.get_mut(&wire.instance_id) {
        legacy.host = host.clone();
        legacy.api_port = wire.api_port;
    }

    // One entry per device; a LAN sighting isn't replaced by a Tailscale one.
    let keep_existing = runtime.discovered.get(&wire.instance_id).is_some_and(|d| d.via == "lan" && tailscale && now.saturating_sub(d.last_seen) < LAN_PREFERENCE_MS);
    if !keep_existing {
        runtime.discovered.insert(
            wire.instance_id.clone(),
            BridgeLinkPeer {
                instance_id: wire.instance_id,
                name: clean_text(&wire.name, "BridgeDeck", 64),
                platform: clean_text(&wire.platform, "unknown", 16),
                host,
                api_port: wire.api_port,
                protocol,
                via: if tailscale { "tailscale" } else { "lan" }.into(),
                last_seen: now,
            },
        );
    }
}

pub(super) fn record_seen(runtime: &mut Runtime, instance_id: &str, host: &str, tailscale: bool, now: u64) {
    let seen = runtime.seen.entry(instance_id.to_string()).or_default();
    seen.retain(|(h, at, _)| h != host && now.saturating_sub(*at) < SEEN_TTL_MS);
    seen.push((host.to_string(), now, tailscale));
    if seen.len() > 6 {
        seen.remove(0);
    }
}

/// `tailscale` on PATH, or where the Mac and Windows apps install it.
fn tailscale_program() -> Option<String> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]
    } else if cfg!(target_os = "windows") {
        &[r"C:\Program Files\Tailscale\tailscale.exe"]
    } else {
        &["/usr/bin/tailscale", "/usr/local/bin/tailscale"]
    };
    candidates.iter().find(|path| Path::new(path).exists()).map(|p| p.to_string()).or_else(|| Some("tailscale".into()))
}

/// Online Tailscale devices' IPv4 addresses, from `tailscale status --json`.
pub(super) fn parse_tailscale_status(raw: &str) -> Vec<IpAddr> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else { return Vec::new() };
    let Some(peers) = value.get("Peer").and_then(|p| p.as_object()) else { return Vec::new() };
    peers
        .values()
        .filter(|peer| peer.get("Online").and_then(|v| v.as_bool()) == Some(true))
        .filter_map(|peer| peer.get("TailscaleIPs")?.as_array()?.iter().filter_map(|ip| ip.as_str()?.parse::<IpAddr>().ok()).find(IpAddr::is_ipv4))
        .collect()
}

fn tailscale_targets() -> Vec<IpAddr> {
    let Some(program) = tailscale_program() else { return Vec::new() };
    let mut command = Command::new(program);
    command.args(["status", "--json"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match command.output() {
        Ok(output) if output.status.success() => parse_tailscale_status(&String::from_utf8_lossy(&output.stdout)),
        _ => Vec::new(),
    }
}

/// Refreshes the Tailscale devices to announce to every 30 s (a no-op without Tailscale).
pub(super) fn spawn_tailscale(manager: BridgeLinkManager, shutdown: Arc<AtomicBool>) {
    thread::spawn(move || {
        while !shutdown.load(Ordering::Relaxed) {
            let targets = tailscale_targets();
            if let Ok(mut runtime) = manager.lock() {
                runtime.tailscale_targets = targets;
            }
            for _ in 0..30 {
                if shutdown.load(Ordering::Relaxed) {
                    return;
                }
                thread::sleep(Duration::from_secs(1));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(protocol: &str) -> DiscoveryWire {
        DiscoveryWire { protocol: protocol.into(), instance_id: "mac-1".into(), name: "Mac".into(), platform: "macos".into(), api_port: 41416 }
    }

    fn paired_runtime(host: &str) -> Runtime {
        let mut runtime = Runtime { instance_id: "me".into(), ..Default::default() };
        runtime.paired.insert("mac-1".into(), PersistedPeer {
            instance_id: "mac-1".into(), name: "Mac".into(), platform: "macos".into(), host: host.into(), api_port: 41416,
            fingerprint: "f".into(), localsend_port: 53317, syncthing_device_id: None, paired_at: 0,
        });
        runtime
    }

    #[test]
    fn paired_device_follows_a_new_lan_address() {
        let mut runtime = paired_runtime("192.168.4.28");
        observe(&mut runtime, wire(PROTOCOL_V2), "192.168.4.40".parse().unwrap(), 1_000);
        assert_eq!(runtime.paired["mac-1"].host, "192.168.4.40");
        assert_eq!(runtime.discovered["mac-1"].via, "lan");
    }

    #[test]
    fn a_recent_lan_address_wins_over_tailscale() {
        let mut runtime = paired_runtime("192.168.4.28");
        observe(&mut runtime, wire(PROTOCOL_V2), "192.168.4.28".parse().unwrap(), 1_000);
        observe(&mut runtime, wire(PROTOCOL_V2), "100.100.1.2".parse().unwrap(), 2_000);
        assert_eq!(runtime.paired["mac-1"].host, "192.168.4.28");
        assert_eq!(runtime.discovered["mac-1"].via, "lan");
        // Away from home: only Tailscale sightings for a while.
        observe(&mut runtime, wire(PROTOCOL_V2), "100.100.1.2".parse().unwrap(), 60_000);
        assert_eq!(runtime.paired["mac-1"].host, "100.100.1.2");
        assert_eq!(runtime.discovered["mac-1"].via, "tailscale");
    }

    #[test]
    fn old_versions_are_listed_but_not_trusted() {
        let mut runtime = paired_runtime("192.168.4.28");
        observe(&mut runtime, wire(PROTOCOL_V1), "192.168.4.99".parse().unwrap(), 1_000);
        assert_eq!(runtime.paired["mac-1"].host, "192.168.4.28", "a v1 announcement never moves a v2 pairing");
        assert_eq!(runtime.discovered["mac-1"].protocol, 1);
    }

    #[test]
    fn own_and_malformed_announcements_are_ignored() {
        let mut runtime = paired_runtime("192.168.4.28");
        observe(&mut runtime, DiscoveryWire { instance_id: "me".into(), ..wire(PROTOCOL_V2) }, "192.168.4.2".parse().unwrap(), 1);
        observe(&mut runtime, DiscoveryWire { instance_id: "bad id!".into(), ..wire(PROTOCOL_V2) }, "192.168.4.3".parse().unwrap(), 1);
        observe(&mut runtime, wire("other/1"), "192.168.4.4".parse().unwrap(), 1);
        assert!(runtime.discovered.is_empty());
    }

    #[test]
    fn tailscale_status_lists_online_ipv4_peers() {
        let raw = r#"{"Self":{"TailscaleIPs":["100.1.1.1"]},"Peer":{
            "a":{"Online":true,"TailscaleIPs":["100.100.1.2","fd7a::1"]},
            "b":{"Online":false,"TailscaleIPs":["100.100.1.3"]},
            "c":{"Online":true,"TailscaleIPs":["fd7a::2","100.100.1.4"]}}}"#;
        let mut ips: Vec<String> = parse_tailscale_status(raw).iter().map(|ip| ip.to_string()).collect();
        ips.sort();
        assert_eq!(ips, vec!["100.100.1.2", "100.100.1.4"]);
        assert!(parse_tailscale_status("not json").is_empty());
    }
}
