use reqwest::{Client, Method, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf, time::Duration};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncthingAutoSetupResult {
    pub ok: bool,
    pub local_device_id: String,
    pub peer_device_id: String,
    pub peer_name: String,
    pub device_added: bool,
    pub folder_created: bool,
    pub folder_updated: bool,
    pub folder_id: String,
    pub folder_label: String,
    pub folder_path: String,
    pub restart_required: bool,
    pub detail: String,
}

fn checked_base(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Syncthing URL must start with http:// or https://".into());
    }
    Ok(base.to_string())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

async fn request_json(
    client: &Client,
    base: &str,
    api_key: &str,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<(StatusCode, Value), String> {
    let mut request = client
        .request(method, format!("{base}{path}"))
        .header("X-API-Key", api_key);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            json!({ "raw": String::from_utf8_lossy(&bytes).to_string() })
        })
    };
    Ok((status, value))
}

fn default_shared_path() -> Result<PathBuf, String> {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map_err(|_| "Could not determine the user home directory for the shared folder")?;
    Ok(PathBuf::from(home).join("BridgeDeck Shared"))
}

fn safe_folder_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok("bridgedeck-shared".into());
    }
    if value.len() > 64 || !value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err("Shared folder ID may only contain letters, numbers, '.', '_' and '-'".into());
    }
    Ok(value.to_string())
}

fn normalize_device_id(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_uppercase();
    if value.len() < 20 || !value.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-') {
        return Err("The paired computer did not provide a valid Syncthing device ID".into());
    }
    Ok(value)
}

fn device_entry(device_id: &str) -> Value {
    json!({
        "deviceID": device_id,
        "introducedBy": "",
        "encryptionPassword": ""
    })
}

#[tauri::command]
pub async fn syncthing_setup_peer(
    base_url: String,
    api_key: String,
    peer_device_id: String,
    peer_name: String,
    folder_id: String,
    folder_label: String,
    folder_path: String,
) -> Result<SyncthingAutoSetupResult, String> {
    if api_key.trim().is_empty() {
        return Err("Add the local Syncthing API key in BridgeDeck Settings first".into());
    }
    let base = checked_base(&base_url)?;
    let peer_device_id = normalize_device_id(&peer_device_id)?;
    let folder_id = safe_folder_id(&folder_id)?;
    let folder_label = if folder_label.trim().is_empty() {
        "BridgeDeck Shared".to_string()
    } else {
        folder_label.trim().to_string()
    };
    let requested_path = if folder_path.trim().is_empty() {
        default_shared_path()?
    } else {
        PathBuf::from(folder_path.trim())
    };
    fs::create_dir_all(&requested_path).map_err(|e| format!("Could not create shared folder {}: {e}", requested_path.display()))?;

    let client = client()?;
    let (status_code, status) = request_json(&client, &base, &api_key, Method::GET, "/rest/system/status", None).await?;
    if !status_code.is_success() {
        return Err(format!("Syncthing status returned HTTP {status_code}"));
    }
    let local_device_id = status
        .get("myID")
        .and_then(Value::as_str)
        .ok_or("Syncthing did not return its local device ID")?
        .to_string();
    if local_device_id.eq_ignore_ascii_case(&peer_device_id) {
        return Err("The paired Syncthing device ID matches this computer".into());
    }

    let (devices_status, devices_value) = request_json(&client, &base, &api_key, Method::GET, "/rest/config/devices", None).await?;
    if !devices_status.is_success() {
        return Err(format!("Syncthing device config returned HTTP {devices_status}"));
    }
    let device_exists = devices_value
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item.get("deviceID").and_then(Value::as_str).is_some_and(|id| id.eq_ignore_ascii_case(&peer_device_id))));
    let mut device_added = false;
    if !device_exists {
        let (template_status, mut device) = request_json(&client, &base, &api_key, Method::GET, "/rest/config/defaults/device", None).await?;
        if !template_status.is_success() {
            return Err(format!("Syncthing default device template returned HTTP {template_status}"));
        }
        let object = device.as_object_mut().ok_or("Syncthing default device template was not an object")?;
        object.insert("deviceID".into(), Value::String(peer_device_id.clone()));
        object.insert("name".into(), Value::String(peer_name.trim().to_string()));
        let (post_status, post_body) = request_json(&client, &base, &api_key, Method::POST, "/rest/config/devices", Some(&device)).await?;
        if !post_status.is_success() {
            return Err(format!("Could not add Syncthing device: HTTP {post_status} {post_body}"));
        }
        device_added = true;
    }

    let (folders_status, folders_value) = request_json(&client, &base, &api_key, Method::GET, "/rest/config/folders", None).await?;
    if !folders_status.is_success() {
        return Err(format!("Syncthing folder config returned HTTP {folders_status}"));
    }
    let existing_folder = folders_value
        .as_array()
        .and_then(|items| items.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(folder_id.as_str())))
        .cloned();

    let mut folder_created = false;
    let mut folder_updated = false;
    let effective_path: String;
    if let Some(folder) = existing_folder {
        effective_path = folder
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| requested_path.to_string_lossy().to_string());
        let mut devices = folder.get("devices").and_then(Value::as_array).cloned().unwrap_or_default();
        let has_local = devices.iter().any(|entry| entry.get("deviceID").and_then(Value::as_str).is_some_and(|id| id.eq_ignore_ascii_case(&local_device_id)));
        let has_peer = devices.iter().any(|entry| entry.get("deviceID").and_then(Value::as_str).is_some_and(|id| id.eq_ignore_ascii_case(&peer_device_id)));
        if !has_local {
            devices.push(device_entry(&local_device_id));
        }
        if !has_peer {
            devices.push(device_entry(&peer_device_id));
        }
        if !has_local || !has_peer {
            let patch = json!({ "devices": devices });
            let path = format!("/rest/config/folders/{folder_id}");
            let (patch_status, patch_body) = request_json(&client, &base, &api_key, Method::PATCH, &path, Some(&patch)).await?;
            if !patch_status.is_success() {
                return Err(format!("Could not share existing Syncthing folder: HTTP {patch_status} {patch_body}"));
            }
            folder_updated = true;
        }
    } else {
        let (template_status, mut folder) = request_json(&client, &base, &api_key, Method::GET, "/rest/config/defaults/folder", None).await?;
        if !template_status.is_success() {
            return Err(format!("Syncthing default folder template returned HTTP {template_status}"));
        }
        let object = folder.as_object_mut().ok_or("Syncthing default folder template was not an object")?;
        object.insert("id".into(), Value::String(folder_id.clone()));
        object.insert("label".into(), Value::String(folder_label.clone()));
        object.insert("path".into(), Value::String(requested_path.to_string_lossy().to_string()));
        object.insert("type".into(), Value::String("sendreceive".into()));
        object.insert("devices".into(), Value::Array(vec![device_entry(&local_device_id), device_entry(&peer_device_id)]));
        let (post_status, post_body) = request_json(&client, &base, &api_key, Method::POST, "/rest/config/folders", Some(&folder)).await?;
        if !post_status.is_success() {
            return Err(format!("Could not create Syncthing shared folder: HTTP {post_status} {post_body}"));
        }
        folder_created = true;
        effective_path = requested_path.to_string_lossy().to_string();
    }

    let (restart_status, restart_value) = request_json(&client, &base, &api_key, Method::GET, "/rest/config/restart-required", None).await?;
    let restart_required = restart_status.is_success()
        && (restart_value.get("requiresRestart").and_then(Value::as_bool)
            .or_else(|| restart_value.get("restartRequired").and_then(Value::as_bool))
            .unwrap_or(false));

    // Best effort: ask Syncthing to scan the shared folder after configuration.
    let scan_path = format!("/rest/db/scan?folder={folder_id}");
    let _ = request_json(&client, &base, &api_key, Method::POST, &scan_path, None).await;

    let detail = match (device_added, folder_created, folder_updated) {
        (false, false, false) => "Syncthing device and BridgeDeck Shared folder were already configured".to_string(),
        _ => format!(
            "Syncthing linked {} and shared {}{}",
            if peer_name.trim().is_empty() { &peer_device_id } else { peer_name.trim() },
            folder_label,
            if restart_required { " (Syncthing restart required)" } else { "" }
        ),
    };

    Ok(SyncthingAutoSetupResult {
        ok: true,
        local_device_id,
        peer_device_id,
        peer_name,
        device_added,
        folder_created,
        folder_updated,
        folder_id,
        folder_label,
        folder_path: effective_path,
        restart_required,
        detail,
    })
}
