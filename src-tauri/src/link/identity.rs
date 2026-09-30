//! This device's long-term identity for BridgeLink v2: a self-signed certificate whose SHA-256
//! fingerprint paired devices pin. The private key never leaves this device.

use base64::{engine::general_purpose::STANDARD, Engine};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

const FILE: &str = "identity-v2.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityFile {
    cert_der: String,
    key_pkcs8: String,
}

#[derive(Clone)]
pub struct Identity {
    pub cert: CertificateDer<'static>,
    key: Vec<u8>,
    pub fingerprint: String,
}

impl Identity {
    pub fn key(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.clone()))
    }

    pub fn generate() -> Result<Self, String> {
        let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
        let params = rcgen::CertificateParams::new(vec!["bridgedeck".to_string()]).map_err(|e| e.to_string())?;
        let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
        Ok(Self::from_parts(cert.der().to_vec(), key.serialize_der()))
    }

    fn from_parts(cert: Vec<u8>, key: Vec<u8>) -> Self {
        Self { fingerprint: fingerprint(&cert), cert: CertificateDer::from(cert), key }
    }

    /// Loads the identity from `dir`, creating it on first run (file mode 0600 on Unix).
    pub fn load_or_create(dir: &Path) -> Result<Self, String> {
        let path = dir.join(FILE);
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(file) = serde_json::from_str::<IdentityFile>(&raw) {
                if let (Ok(cert), Ok(key)) = (STANDARD.decode(file.cert_der), STANDARD.decode(file.key_pkcs8)) {
                    return Ok(Self::from_parts(cert, key));
                }
            }
        }
        let identity = Self::generate()?;
        let file = IdentityFile { cert_der: STANDARD.encode(identity.cert.as_ref()), key_pkcs8: STANDARD.encode(&identity.key) };
        let raw = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        fs::write(&path, raw).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        }
        Ok(identity)
    }
}

/// Lowercase hex SHA-256 of a certificate's DER encoding.
pub fn fingerprint(cert_der: &[u8]) -> String {
    Sha256::digest(cert_der).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_persists_and_fingerprints_differ() {
        let dir = std::env::temp_dir().join(format!("bd-identity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let a = Identity::load_or_create(&dir).unwrap();
        let again = Identity::load_or_create(&dir).unwrap();
        assert_eq!(a.fingerprint, again.fingerprint);
        assert_eq!(a.fingerprint.len(), 64);
        assert_ne!(a.fingerprint, Identity::generate().unwrap().fingerprint);
        let _ = fs::remove_dir_all(dir);
    }
}
