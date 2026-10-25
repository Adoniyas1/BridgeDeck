//! Pictures in notes (figures cut from a photo of handwritten notes, for now). An image block's
//! text is the picture's id; the picture is `<shared folder>/Note images/<id>.jpg` (or `.png`), so
//! it syncs with the shared folder like drawings and ink.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const MAX_PICTURE: usize = 12 * 1024 * 1024;

pub fn folder_in(shared: &Path) -> PathBuf {
    shared.join("Note images")
}

fn folder(app: &AppHandle) -> PathBuf {
    let shared = crate::shared_folder(app);
    let shared = if shared.trim().is_empty() { crate::study::default_shared() } else { PathBuf::from(shared.trim()) };
    folder_in(&shared)
}

fn kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else {
        None
    }
}

pub fn save_in(dir: &Path, id: &str, bytes: &[u8]) -> Result<(), String> {
    if !crate::drawings::valid_id(id) {
        return Err("Not a picture id".into());
    }
    let ext = kind(bytes).filter(|_| bytes.len() <= MAX_PICTURE).ok_or("Only JPEG or PNG pictures up to 12 MB")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let partial = dir.join(format!(".{id}.{ext}.partial"));
    fs::write(&partial, bytes).and_then(|_| fs::rename(&partial, dir.join(format!("{id}.{ext}")))).map_err(|e| format!("Couldn't save the picture: {e}"))
}

pub fn load_in(dir: &Path, id: &str) -> Option<(Vec<u8>, &'static str)> {
    if !crate::drawings::valid_id(id) {
        return None;
    }
    ["jpg", "png"].into_iter().find_map(|ext| fs::read(dir.join(format!("{id}.{ext}"))).ok().map(|b| (b, if ext == "jpg" { "image/jpeg" } else { "image/png" })))
}

/// A picture as the request body; its id in the `x-id` header.
#[tauri::command]
pub fn note_image_save(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let id = request.headers().get("x-id").and_then(|v| v.to_str().ok()).ok_or("Missing x-id")?.to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Send the picture as bytes".into()) };
    save_in(&folder(&app), &id, bytes)
}

/// A picture as a data URL for the note, or None when it isn't here (yet: it may still be syncing).
#[tauri::command]
pub fn note_image_load(app: AppHandle, id: String) -> Option<String> {
    use base64::Engine;
    load_in(&folder(&app), &id).map(|(bytes, mime)| format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_loads_pictures_by_id() {
        let dir = std::env::temp_dir().join(format!("bd-note-images-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let png = b"\x89PNG\r\n\x1a\nrest";
        save_in(&dir, "img_1", png).unwrap();
        assert_eq!(load_in(&dir, "img_1"), Some((png.to_vec(), "image/png")));
        assert!(save_in(&dir, "../x", png).is_err());
        assert!(save_in(&dir, "img_2", b"GIF89a").is_err());
        assert_eq!(load_in(&dir, "missing"), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
