//! The CAD tab's files: models (replicad scripts) in the shared folder's `CAD` folder, so both
//! computers have them, and exports (STL for printing, STEP for other CAD programs) written where
//! the save dialog says. The modelling itself runs in the window (OpenCascade in WebAssembly).

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::AppHandle;

const EXT: &str = "cad.js";
const MAX_MODEL: usize = 512 * 1024;
const MAX_EXPORT: usize = 512 * 1024 * 1024;

fn folder(app: &AppHandle) -> PathBuf {
    crate::circuits::shared(app).join("CAD")
}

fn file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !crate::circuits::valid_name(name) {
        return Err("That name can't be used for a file (no / \\ : * ? \" < > |)".into());
    }
    Ok(folder(app).join(format!("{}.{EXT}", name.trim())))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CadFile {
    pub name: String,
    pub modified: u64,
}

#[tauri::command]
pub fn cad_files(app: AppHandle) -> Vec<CadFile> {
    let mut out: Vec<CadFile> = fs::read_dir(folder(&app))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let file_name = entry.file_name().to_str()?.to_string();
            let name = file_name.strip_suffix(&format!(".{EXT}"))?.to_string();
            if name.starts_with('.') {
                return None;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            Some(CadFile { name, modified })
        })
        .collect();
    out.sort_by_key(|f| std::cmp::Reverse(f.modified));
    out
}

#[tauri::command]
pub fn cad_load(app: AppHandle, name: String) -> Result<String, String> {
    fs::read_to_string(file(&app, &name)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cad_save(app: AppHandle, name: String, source: String) -> Result<(), String> {
    if source.len() > MAX_MODEL {
        return Err("That model is too long to save".into());
    }
    let path = file(&app, &name)?;
    fs::create_dir_all(folder(&app)).map_err(|e| e.to_string())?;
    fs::write(path, source).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cad_delete(app: AppHandle, name: String) -> Result<(), String> {
    fs::remove_file(file(&app, &name)?).map_err(|e| e.to_string())
}

/// What an export's bytes and file name must look like: an STL (binary, or text starting "solid")
/// to a .stl file, or a STEP file ("ISO-10303-21") to a .step or .stp file.
pub fn export_ok(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    let fits = match ext.as_str() {
        "stl" => bytes.starts_with(b"solid") || (bytes.len() >= 84 && bytes.len() == 84 + 50 * u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize),
        "step" | "stp" => bytes.starts_with(b"ISO-10303-21"),
        _ => return Err("Save it as a .stl, .step or .stp file".into()),
    };
    if !fits || bytes.len() > MAX_EXPORT {
        return Err(format!("That isn't a {} file", ext.to_uppercase()));
    }
    if !path.is_absolute() || !path.parent().is_some_and(Path::is_dir) {
        return Err("Choose where to save it".into());
    }
    Ok(())
}

/// The bytes are the request body; the path (from the save dialog) is in `x-path`, URI-encoded.
#[tauri::command]
pub fn cad_export(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).and_then(crate::study::percent_decode).ok_or("Missing x-path")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Send the file as bytes".into()) };
    let path = PathBuf::from(path);
    export_ok(&path, bytes)?;
    let partial = path.with_extension("partial");
    fs::write(&partial, bytes).and_then(|_| fs::rename(&partial, &path)).map_err(|e| format!("Couldn't save it: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_must_be_what_their_name_says() {
        let dir = std::env::temp_dir();
        let mut binary = vec![0u8; 80];
        binary.extend_from_slice(&1u32.to_le_bytes());
        binary.extend_from_slice(&[0u8; 50]);
        assert!(export_ok(&dir.join("part.stl"), &binary).is_ok());
        assert!(export_ok(&dir.join("part.STL"), b"solid part\nendsolid").is_ok());
        assert!(export_ok(&dir.join("part.step"), b"ISO-10303-21;\nHEADER;").is_ok());
        assert!(export_ok(&dir.join("part.stp"), b"ISO-10303-21;").is_ok());
        assert!(export_ok(&dir.join("part.stl"), b"ISO-10303-21;").is_err());
        assert!(export_ok(&dir.join("part.exe"), b"solid").is_err());
        assert!(export_ok(Path::new("part.stl"), b"solid").is_err());
        binary.push(0);
        assert!(export_ok(&dir.join("part.stl"), &binary).is_err());
    }
}
