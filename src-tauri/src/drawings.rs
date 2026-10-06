//! Drawings in notes (Excalidraw). A drawing block's text is the drawing's id; the drawing itself is
//! `<shared folder>/Drawings/<id>.excalidraw` (the scene, JSON) with `<id>.svg` (a picture of it for
//! the note and for Markdown), so it syncs to the other computer with the shared folder and isn't
//! limited by the size of a note's text.

use serde::Serialize;
use std::{fs, path::PathBuf};
use tauri::AppHandle;

const MAX_SCENE: usize = 20 * 1024 * 1024;
const MAX_PICTURE: usize = 10 * 1024 * 1024;

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let shared = crate::shared_folder(app);
    // A blank setting means the usual place (~/BridgeDeck Shared).
    let shared = if shared.trim().is_empty() { crate::study::default_shared() } else { PathBuf::from(shared.trim()) };
    Ok(shared.join("Drawings"))
}

#[derive(Serialize)]
pub struct Drawing {
    pub scene: Option<String>,
    pub svg: Option<String>,
}

#[tauri::command]
pub fn drawing_load(app: AppHandle, id: String) -> Result<Drawing, String> {
    if !valid_id(&id) {
        return Err("Not a drawing".into());
    }
    let dir = folder(&app)?;
    Ok(Drawing {
        scene: fs::read_to_string(dir.join(format!("{id}.excalidraw"))).ok(),
        svg: fs::read_to_string(dir.join(format!("{id}.svg"))).ok(),
    })
}

#[tauri::command]
pub fn drawing_save(app: AppHandle, id: String, scene: String, svg: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Not a drawing".into());
    }
    if scene.len() > MAX_SCENE || svg.len() > MAX_PICTURE {
        return Err("That drawing is too big to save".into());
    }
    serde_json::from_str::<serde_json::Value>(&scene).map_err(|_| "The drawing couldn't be read".to_string())?;
    if !svg.trim_start().starts_with("<svg") {
        return Err("The drawing's picture couldn't be made".into());
    }
    let dir = folder(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, data) in [(format!("{id}.excalidraw"), scene), (format!("{id}.svg"), svg)] {
        let part = dir.join(format!("{name}.part"));
        fs::write(&part, data).map_err(|e| e.to_string())?;
        fs::rename(&part, dir.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn ids_are_plain_names() {
        assert!(super::valid_id("a1B2-c_3"));
        assert!(!super::valid_id("../x") && !super::valid_id("") && !super::valid_id("a/b"));
    }
}
