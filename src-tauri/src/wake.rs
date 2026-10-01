//! Wake-on-LAN: a paired computer reports its network cards' hardware addresses while it's awake;
//! when it's asleep, the other computer broadcasts the "magic packet" that wakes it. This only works
//! on the same network (not over Tailscale) and when the sleeping computer allows it (Windows: the
//! network adapter's power settings; Mac: Energy → "Wake for network access").

use std::net::{Ipv4Addr, SocketAddr, UdpSocket};

/// This computer's hardware addresses, "aa:bb:cc:dd:ee:ff", for the paired computers to keep.
pub fn local_macs() -> Vec<String> {
    let Ok(addresses) = mac_address::MacAddressIterator::new() else { return Vec::new() };
    let mut macs: Vec<String> = addresses
        .map(|mac| mac.bytes())
        .filter(|bytes| bytes.iter().any(|b| *b != 0) && bytes[0] & 1 == 0)
        .map(|b| format!("{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}", b[0], b[1], b[2], b[3], b[4], b[5]))
        .collect();
    macs.sort();
    macs.dedup();
    macs.truncate(8);
    macs
}

pub fn parse_mac(text: &str) -> Option<[u8; 6]> {
    let parts: Vec<u8> = text.split([':', '-']).map(|p| u8::from_str_radix(p, 16)).collect::<Result<_, _>>().ok()?;
    let bytes: [u8; 6] = parts.try_into().ok()?;
    (bytes.iter().any(|b| *b != 0) && bytes[0] & 1 == 0).then_some(bytes)
}

/// Six 0xFF bytes, then the address sixteen times.
pub fn magic_packet(mac: [u8; 6]) -> [u8; 102] {
    let mut packet = [0xFF; 102];
    for chunk in packet[6..].chunks_mut(6) {
        chunk.copy_from_slice(&mac);
    }
    packet
}

/// Broadcasts the packet for every address, to the whole network and to the subnet each last-known
/// IPv4 address belongs to (assuming a /24, the usual home network).
pub fn send(macs: &[String], last_known: &[SocketAddr]) -> Result<usize, String> {
    let macs: Vec<[u8; 6]> = macs.iter().filter_map(|m| parse_mac(m)).collect();
    if macs.is_empty() {
        return Err("This computer hasn't reported its network address yet. Wake it once by hand; BridgeDeck learns it while both are on.".into());
    }
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    let mut targets = vec![Ipv4Addr::BROADCAST];
    for address in last_known {
        if let SocketAddr::V4(v4) = address {
            let ip = v4.ip();
            // Tailscale addresses (100.64.0.0/10) can't carry a wake-up packet.
            if ip.is_private() {
                let [a, b, c, _] = ip.octets();
                targets.push(Ipv4Addr::new(a, b, c, 255));
            }
        }
    }
    targets.dedup();
    let mut sent = 0;
    for mac in &macs {
        let packet = magic_packet(*mac);
        for target in &targets {
            for port in [9, 7] {
                if socket.send_to(&packet, (*target, port)).is_ok() {
                    sent += 1;
                }
            }
        }
    }
    if sent == 0 {
        return Err("Could not send the wake-up packet on this network".into());
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_is_sync_then_sixteen_copies() {
        let mac = parse_mac("AA-bb-cc-01-02-03").unwrap();
        let packet = magic_packet(mac);
        assert_eq!(&packet[..6], &[0xFF; 6]);
        assert!(packet[6..].chunks(6).all(|c| c == mac));
        assert_eq!(packet[6..].len(), 16 * 6);
    }

    #[test]
    fn only_real_hardware_addresses_are_accepted() {
        assert!(parse_mac("00:00:00:00:00:00").is_none());
        assert!(parse_mac("01:00:5e:00:00:01").is_none()); // multicast
        assert!(parse_mac("aa:bb:cc").is_none());
        assert!(parse_mac("zz:bb:cc:dd:ee:ff").is_none());
        assert_eq!(parse_mac("a4:83:e7:12:34:56"), Some([0xa4, 0x83, 0xe7, 0x12, 0x34, 0x56]));
    }
}
