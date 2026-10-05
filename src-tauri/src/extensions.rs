//! Chrome extensions for the Browser and TV tabs and the ChatGPT panel, on Windows: WebView2 is
//! Chromium (Microsoft Edge) and loads unpacked extensions from a folder. macOS's web view is
//! Safari's WebKit, which can't run Chrome extensions, so there these commands say so.
//!
//! Each extension is a folder in `<app data>/extensions/`, added from an unpacked folder, a `.crx`
//! (Chrome's package: a header, then a zip) or a `.zip`. They load when the pages are next created,
//! which is the next time BridgeDeck starts.

use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extension {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
}

pub fn dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("extensions"))
}

/// The folder for the web pages' own browser data on Windows. It's apart from BridgeDeck's own
/// page because WebView2 only shares a folder between views made with the same settings, and
/// these pages are made with extensions on.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn web_data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("web-pages"))
}

/// A name from the manifest, resolving `__MSG_name__` from the English messages when present.
fn manifest_text(folder: &Path, value: &serde_json::Value) -> String {
    let text = value.as_str().unwrap_or_default().to_string();
    let Some(key) = text.strip_prefix("__MSG_").and_then(|t| t.strip_suffix("__")) else { return text };
    for locale in ["en", "en_US", "en_GB"] {
        if let Ok(raw) = fs::read_to_string(folder.join("_locales").join(locale).join("messages.json")) {
            if let Ok(messages) = serde_json::from_str::<serde_json::Value>(&raw) {
                let found = messages.as_object().and_then(|m| m.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.clone()));
                if let Some(message) = found.and_then(|v| v["message"].as_str().map(str::to_string)) {
                    return message;
                }
            }
        }
    }
    text
}

fn read(folder: &Path) -> Option<Extension> {
    let manifest: serde_json::Value = serde_json::from_str(&fs::read_to_string(folder.join("manifest.json")).ok()?).ok()?;
    Some(Extension {
        id: folder.file_name()?.to_string_lossy().to_string(),
        name: manifest_text(folder, &manifest["name"]),
        version: manifest["version"].as_str().unwrap_or_default().to_string(),
        description: manifest_text(folder, &manifest["description"]),
    })
}

pub fn list(root: &Path) -> Vec<Extension> {
    let mut out: Vec<Extension> = fs::read_dir(root).into_iter().flatten().flatten().filter(|e| e.path().is_dir()).filter_map(|e| read(&e.path())).collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// The zip inside a `.crx` file (versions 2 and 3), or the bytes as they are when it's a zip.
pub fn crx_zip(bytes: &[u8]) -> Result<&[u8], String> {
    if !bytes.starts_with(b"Cr24") {
        return Ok(bytes);
    }
    let word = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize).ok_or("A damaged .crx file");
    let start = match word(4)? {
        3 => 12 + word(8)?,
        2 => 16 + word(8)? + word(12)?,
        v => return Err(format!("Unknown .crx version {v}")),
    };
    bytes.get(start..).ok_or_else(|| "A damaged .crx file".to_string())
}

/// A folder-safe name for an extension.
fn folder_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let clean = clean.trim_matches('-').to_string();
    if clean.is_empty() { "extension".into() } else { clean.chars().take(60).collect() }
}

/// Unpacks a zip into `dest`, keeping only safe paths. The extension's files may sit in a
/// top-level folder; that folder is dropped so `manifest.json` ends up at `dest`.
pub fn unzip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "That isn't a zip or .crx file".to_string())?;
    let names: Vec<PathBuf> = (0..archive.len()).filter_map(|i| archive.by_index(i).ok().and_then(|f| f.enclosed_name())).collect();
    let manifest = names.iter().filter(|n| n.file_name().is_some_and(|f| f == "manifest.json")).min_by_key(|n| n.components().count()).ok_or("There's no manifest.json in it, so it isn't an extension")?;
    let prefix = manifest.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(path) = file.enclosed_name() else { continue };
        let Ok(rel) = path.strip_prefix(&prefix) else { continue };
        let out = dest.join(rel);
        if file.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        total += file.size();
        if total > 200 * 1024 * 1024 {
            return Err("That extension is too big".into());
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data).map_err(|e| e.to_string())?;
        fs::write(&out, data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        let target = to.join(entry.file_name());
        if kind.is_dir() { copy_dir(&entry.path(), &target)? } else { fs::copy(entry.path(), &target).map(|_| ()).map_err(|e| e.to_string())? }
    }
    Ok(())
}

/// Adds an extension from a folder, `.crx` or `.zip`; returns it. Replaces one of the same name.
pub fn add(root: &Path, source: &Path) -> Result<Extension, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let staging = root.join(".adding");
    let _ = fs::remove_dir_all(&staging);
    if source.is_dir() {
        if !source.join("manifest.json").exists() {
            return Err("That folder has no manifest.json, so it isn't an unpacked extension".into());
        }
        copy_dir(source, &staging)?;
    } else {
        let bytes = fs::read(source).map_err(|e| e.to_string())?;
        unzip(crx_zip(&bytes)?, &staging)?;
    }
    let found = read(&staging).ok_or("Its manifest.json couldn't be read")?;
    let dest = root.join(folder_name(&found.name));
    let _ = fs::remove_dir_all(&dest);
    fs::rename(&staging, &dest).map_err(|e| e.to_string())?;
    read(&dest).ok_or_else(|| "The extension couldn't be read after adding it".into())
}

pub fn remove(root: &Path, id: &str) -> Result<(), String> {
    if id.is_empty() || id.starts_with('.') || id.contains(['/', '\\']) {
        return Err("No such extension".into());
    }
    fs::remove_dir_all(root.join(id)).map_err(|e| e.to_string())
}

fn windows_only() -> Result<(), String> {
    if cfg!(windows) { Ok(()) } else { Err("Chrome extensions work in BridgeDeck on Windows only: on a Mac, web pages use Safari's engine, which can't run them. The built-in ad blocker works on both.".into()) }
}

#[tauri::command]
pub fn extensions_list(app: AppHandle) -> Vec<Extension> {
    dir(&app).map(|d| list(&d)).unwrap_or_default()
}

#[tauri::command]
pub async fn extensions_add(app: AppHandle, path: String) -> Result<Extension, String> {
    windows_only()?;
    let root = dir(&app).ok_or("No app data folder")?;
    tauri::async_runtime::spawn_blocking(move || add(&root, Path::new(&path))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn extensions_remove(app: AppHandle, id: String) -> Result<(), String> {
    remove(&dir(&app).ok_or("No app data folder")?, &id)
}

/// Downloads the latest uBlock Origin Lite for Chromium from its GitHub releases and adds it.
#[tauri::command]
pub async fn extensions_get_ublock(app: AppHandle) -> Result<Extension, String> {
    windows_only()?;
    let root = dir(&app).ok_or("No app data folder")?;
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(120)).user_agent("BridgeDeck").build().map_err(|e| e.to_string())?;
        let release: serde_json::Value = client.get("https://api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest").send().and_then(|r| r.error_for_status()).and_then(|r| r.json()).map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
        let asset = release["assets"].as_array().into_iter().flatten()
            .find(|a| a["name"].as_str().is_some_and(|n| n.contains("chromium") && n.ends_with(".zip")))
            .and_then(|a| a["browser_download_url"].as_str()).ok_or("No Chromium download in the latest uBlock Origin Lite release")?;
        if !asset.starts_with("https://github.com/") {
            return Err("Unexpected download address".into());
        }
        let bytes = client.get(asset).send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes()).map_err(|e| format!("Couldn't download it: {e}"))?;
        let file = root.join(".ubol.zip");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        fs::write(&file, &bytes).map_err(|e| e.to_string())?;
        let added = add(&root, &file);
        let _ = fs::remove_file(&file);
        added
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(files: &[(&str, &str)]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut out);
            for (name, body) in files {
                zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        out.into_inner()
    }

    #[test]
    fn adds_from_zip_and_crx_and_lists_by_name() {
        let root = std::env::temp_dir().join(format!("bd-ext-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let manifest = r#"{"manifest_version":3,"name":"__MSG_name__","version":"1.2","description":"Blocks ads"}"#;
        let zip = zip_with(&[("ubol/manifest.json", manifest), ("ubol/_locales/en/messages.json", r#"{"name":{"message":"uBlock Origin Lite"}}"#), ("ubol/js/a.js", "x")]);
        let file = root.join("in.zip");
        fs::create_dir_all(&root).unwrap();
        fs::write(&file, &zip).unwrap();
        let added = add(&root.join("ext"), &file).unwrap();
        assert_eq!((added.name.as_str(), added.version.as_str(), added.id.as_str()), ("uBlock Origin Lite", "1.2", "uBlock-Origin-Lite"));
        assert!(root.join("ext/uBlock-Origin-Lite/js/a.js").exists(), "the top folder is dropped");

        // A .crx (version 3): "Cr24", version, header length, header, then the zip.
        let mut crx = b"Cr24".to_vec();
        crx.extend(3u32.to_le_bytes());
        crx.extend(4u32.to_le_bytes());
        crx.extend([0u8; 4]);
        crx.extend(zip_with(&[("manifest.json", r#"{"name":"Dark Reader","version":"4.9"}"#)]));
        fs::write(root.join("dr.crx"), &crx).unwrap();
        add(&root.join("ext"), &root.join("dr.crx")).unwrap();
        let names: Vec<String> = list(&root.join("ext")).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["Dark Reader", "uBlock Origin Lite"]);

        assert!(add(&root.join("ext"), &file.with_extension("nope")).is_err());
        fs::write(root.join("bad.zip"), zip_with(&[("readme.txt", "hi")])).unwrap();
        assert!(add(&root.join("ext"), &root.join("bad.zip")).unwrap_err().contains("manifest.json"));
        remove(&root.join("ext"), "Dark-Reader").unwrap();
        assert!(remove(&root.join("ext"), "../x").is_err());
        assert_eq!(list(&root.join("ext")).len(), 1);
        let _ = fs::remove_dir_all(&root);
    }
}
