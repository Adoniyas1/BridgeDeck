//! Short authentication string for pairing (numeric comparison with a commitment, as in Bluetooth
//! Secure Simple Pairing). The responder commits to its nonce before seeing the initiator's, so a
//! device in the middle, which sees different certificates on each side, gets matching six-digit codes
//! on both screens with probability one in a million per attempt, and every attempt is visible.

use sha2::{Digest, Sha256};

pub fn nonce() -> [u8; 32] {
    rand::random()
}

fn hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u32).to_be_bytes());
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// The responder's commitment to `responder_nonce`, bound to both certificates.
pub fn commitment(responder_fp: &str, initiator_fp: &str, responder_nonce: &[u8]) -> [u8; 32] {
    hash(&[b"bridgedeck-commit-v1", responder_fp.as_bytes(), initiator_fp.as_bytes(), responder_nonce])
}

/// The six-digit code both screens show. Arguments are always initiator first.
pub fn code(initiator_fp: &str, responder_fp: &str, initiator_nonce: &[u8], responder_nonce: &[u8]) -> String {
    let digest = hash(&[b"bridgedeck-sas-v1", initiator_fp.as_bytes(), responder_fp.as_bytes(), initiator_nonce, responder_nonce]);
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{value:06}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_sides_compute_the_same_code() {
        let (na, nb) = (nonce(), nonce());
        assert_eq!(code("a", "b", &na, &nb), code("a", "b", &na, &nb));
        assert_eq!(code("a", "b", &na, &nb).len(), 6);
    }

    #[test]
    fn a_device_in_the_middle_changes_the_code() {
        let (na, nb) = (nonce(), nonce());
        // The initiator sees the attacker's certificate "m", the responder sees "m2".
        assert_ne!(code("a", "m", &na, &nb), code("m2", "b", &na, &nb));
    }

    #[test]
    fn commitment_binds_nonce_and_certificates() {
        let nb = nonce();
        let c = commitment("b", "a", &nb);
        assert_eq!(c, commitment("b", "a", &nb));
        assert_ne!(c, commitment("b", "a", &nonce()));
        assert_ne!(c, commitment("b", "m", &nb));
    }
}
