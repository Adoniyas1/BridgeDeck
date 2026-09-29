//! Secrets from the settings file (API keys, passwords, bearer tokens, PINs) are kept in the OS
//! credential store (macOS Keychain, Windows Credential Manager) instead of the JSON on disk.
//!
//! They are stored as one credential holding a small JSON map, so a locally signed Mac build that
//! macOS treats as a new app after each rebuild asks for Keychain access once, not once per secret.

use serde_json::Value;
use std::{collections::BTreeMap, sync::Mutex};

const SERVICE: &str = "dev.bridgedeck.app";
const ACCOUNT: &str = "settings-secrets";

/// Where secrets live in the settings JSON. `*` stands for every element of an array; elements are
/// keyed by their `id`, so a secret follows its device when the list is reordered.
const SECRET_PATHS: &[&str] = &[
    "/syncthing/apiKey",
    "/bluebubbles/password",
    "/localsend/pin",
    "/devices/*/agentToken",
    "/devices/*/localsendPin",
];

pub type Secrets = BTreeMap<String, String>;

/// The last map written to the credential store, so unchanged saves (every settings keystroke)
/// don't rewrite it.
static STORED: Mutex<Option<Secrets>> = Mutex::new(None);

/// Visits every secret field in `config`, with its stable key (for example `/devices/<id>/agentToken`).
fn for_each_field(config: &mut Value, mut visit: impl FnMut(String, &mut Value)) {
    for path in SECRET_PATHS {
        match path.split_once("/*/") {
            None => {
                if let Some(field) = config.pointer_mut(path) {
                    visit(path.to_string(), field);
                }
            }
            Some((array, field)) => {
                let Some(items) = config.pointer_mut(array).and_then(Value::as_array_mut) else { continue };
                for item in items {
                    let Some(id) = item.get("id").and_then(Value::as_str).map(str::to_string) else { continue };
                    if let Some(value) = item.get_mut(field) {
                        visit(format!("{array}/{id}/{field}"), value);
                    }
                }
            }
        }
    }
}

/// Removes non-empty secrets from `config` (leaving empty strings) and returns them.
pub fn split(config: &mut Value) -> Secrets {
    let mut secrets = Secrets::new();
    for_each_field(config, |key, value| {
        if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
            secrets.insert(key, text.to_string());
            *value = Value::String(String::new());
        }
    });
    secrets
}

/// Fills empty secret fields in `config` from `secrets`.
pub fn merge(config: &mut Value, secrets: &Secrets) {
    for_each_field(config, |key, value| {
        let empty = value.as_str().is_none_or(str::is_empty);
        if let (true, Some(secret)) = (empty, secrets.get(&key)) {
            *value = Value::String(secret.clone());
        }
    });
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

/// Reads the stored secrets; an absent credential is an empty map.
pub fn load() -> Result<Secrets, String> {
    let secrets = match entry()?.get_secret() {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("Stored settings secrets are unreadable: {e}"))?,
        Err(keyring::Error::NoEntry) => Secrets::new(),
        Err(error) => return Err(error.to_string()),
    };
    *STORED.lock().map_err(|_| "secrets lock poisoned")? = Some(secrets.clone());
    Ok(secrets)
}

/// Replaces the stored secrets with `secrets` (deleting the credential when there are none).
/// Refuses until `load` has succeeded: if the credential store couldn't be read (for example the user
/// denied Keychain access), writing now could replace secrets this process never saw.
pub fn store(secrets: &Secrets) -> Result<(), String> {
    let mut stored = STORED.lock().map_err(|_| "secrets lock poisoned")?;
    match stored.as_ref() {
        None => return Err("the credential store has not been read successfully".into()),
        Some(current) if current == secrets => return Ok(()),
        Some(_) => {}
    }
    let entry = entry()?;
    if secrets.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    } else {
        let bytes = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
        entry.set_secret(&bytes).map_err(|e| e.to_string())?;
    }
    *stored = Some(secrets.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "syncthing": { "baseUrl": "http://127.0.0.1:8384", "apiKey": "st-key" },
            "bluebubbles": { "baseUrl": "", "password": "" },
            "localsend": { "pin": "1234", "port": 53317 },
            "devices": [
                { "id": "mac-instance", "name": "Mac", "agentToken": "peer-token", "localsendPin": "" },
                { "id": "win-instance", "name": "Windows", "agentToken": "", "localsendPin": "9999" }
            ]
        })
    }

    #[test]
    fn split_removes_only_non_empty_secrets() {
        let mut config = sample();
        let secrets = split(&mut config);
        assert_eq!(secrets.len(), 4);
        assert_eq!(secrets["/syncthing/apiKey"], "st-key");
        assert_eq!(secrets["/localsend/pin"], "1234");
        assert_eq!(secrets["/devices/mac-instance/agentToken"], "peer-token");
        assert_eq!(secrets["/devices/win-instance/localsendPin"], "9999");
        assert_eq!(config["syncthing"]["apiKey"], "");
        assert_eq!(config["devices"][0]["agentToken"], "");
        // Non-secret fields are untouched.
        assert_eq!(config["syncthing"]["baseUrl"], "http://127.0.0.1:8384");
        assert_eq!(config["devices"][1]["name"], "Windows");
    }

    #[test]
    fn merge_restores_split_config() {
        let original = sample();
        let mut config = original.clone();
        let secrets = split(&mut config);
        merge(&mut config, &secrets);
        assert_eq!(config, original);
    }

    #[test]
    fn secrets_follow_devices_by_id() {
        let mut config = sample();
        let secrets = split(&mut config);
        config["devices"].as_array_mut().unwrap().reverse();
        merge(&mut config, &secrets);
        assert_eq!(config["devices"][1]["agentToken"], "peer-token");
        assert_eq!(config["devices"][0]["localsendPin"], "9999");
    }

    #[test]
    fn merge_keeps_values_already_in_the_file() {
        let mut config = sample();
        let mut secrets = Secrets::new();
        secrets.insert("/syncthing/apiKey".into(), "older-key".into());
        merge(&mut config, &secrets);
        assert_eq!(config["syncthing"]["apiKey"], "st-key");
    }

    #[test]
    fn missing_sections_are_skipped() {
        let mut config = json!({ "pairing": { "displayName": "" } });
        assert!(split(&mut config).is_empty());
        merge(&mut config, &Secrets::new());
        assert_eq!(config, json!({ "pairing": { "displayName": "" } }));
    }
}
