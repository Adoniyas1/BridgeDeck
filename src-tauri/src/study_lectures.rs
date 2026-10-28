//! Lecture recordings, kept in a course's `Lectures/` folder (so they sync like its books), each
//! with a sidecar `<file>.json` holding the transcript and what was marked while listening:
//! `{segments: [{start, end, text}], markers: [{t, note?}], photos: [{t, file}], live?: bool}`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::study::{clean_name, course_dir_in, current_root, free_name_in};

pub const LECTURES_DIR: &str = "Lectures";
pub const AUDIO_EXTENSIONS: &[&str] = &["m4a", "mp3", "webm", "ogg", "wav", "aac", "mp4"];
const MAX_AUDIO: usize = 1024 * 1024 * 1024;
const MAX_SIDECAR: usize = 8 * 1024 * 1024;

pub fn is_audio(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

pub fn audio_mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        // A downloaded lecture video plays (and is transcribed) for its sound.
        Some("m4a" | "aac" | "mp4") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        _ => "audio/webm",
    }
}

/// The recording's kind from its first bytes.
fn audio_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("webm")
    } else if bytes.starts_with(b"OggS") {
        Some("ogg")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        Some("wav")
    } else if bytes.len() > 8 && &bytes[4..8] == b"ftyp" {
        Some("m4a")
    } else if bytes.starts_with(b"ID3") || (bytes.len() > 1 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0) {
        Some("mp3")
    } else {
        None
    }
}

fn lectures_dir(course: &Path) -> Result<PathBuf, String> {
    let dir = course.join(LECTURES_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A file name in Lectures/ that is a recording there (no paths).
fn lecture_file(course: &Path, file: &str) -> Result<PathBuf, String> {
    let path = course.join(LECTURES_DIR).join(file);
    if file.contains(['/', '\\']) || file.starts_with('.') || !is_audio(&path) || !path.is_file() {
        return Err("No such recording".into());
    }
    Ok(path)
}

pub fn save_recording(course: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let kind = audio_kind(bytes).filter(|_| bytes.len() <= MAX_AUDIO).ok_or("That isn't a recording BridgeDeck can keep")?;
    let dir = lectures_dir(course)?;
    let stem = Path::new(name.trim()).file_stem().and_then(|s| s.to_str()).unwrap_or("Lecture");
    let file = free_name_in(&dir, &format!("{}.{kind}", clean_name(stem).unwrap_or_else(|_| "Lecture".into())));
    let partial = dir.join(format!(".{file}.partial"));
    fs::write(&partial, bytes).and_then(|_| fs::rename(&partial, dir.join(&file))).map_err(|e| format!("Couldn't save the recording: {e}"))?;
    Ok(file)
}

pub fn import_recording(course: &Path, from: &Path) -> Result<String, String> {
    if !is_audio(from) || !from.is_file() {
        return Err("Choose an audio file (m4a, mp3, webm, ogg or wav) or an mp4 video".into());
    }
    let dir = lectures_dir(course)?;
    let name = from.file_name().and_then(|n| n.to_str()).ok_or("That file has no name")?;
    let file = free_name_in(&dir, &clean_name(name)?);
    fs::copy(from, dir.join(&file)).map_err(|e| format!("Couldn't copy it: {e}"))?;
    Ok(file)
}

#[derive(Serialize)]
pub struct Lecture {
    pub file: String,
    pub bytes: u64,
    pub modified: u64,
    pub sidecar: Option<Value>,
}

pub fn list(course: &Path) -> Vec<Lecture> {
    let dir = course.join(LECTURES_DIR);
    let mut out: Vec<Lecture> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| is_audio(&e.path()) && !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let file = e.file_name().to_string_lossy().to_string();
            let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            Some(Lecture { sidecar: read_sidecar(course, &file), file, bytes: meta.len(), modified })
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

pub fn read_sidecar(course: &Path, file: &str) -> Option<Value> {
    let path = lecture_file(course, file).ok()?;
    let bytes = fs::read(path.with_file_name(format!("{file}.json"))).ok()?;
    (bytes.len() <= MAX_SIDECAR).then(|| serde_json::from_slice(&bytes).ok()).flatten()
}

pub fn write_sidecar(course: &Path, file: &str, data: &Value) -> Result<(), String> {
    let path = lecture_file(course, file)?;
    let text = serde_json::to_string(data).map_err(|e| e.to_string())?;
    if text.len() > MAX_SIDECAR || !data.is_object() {
        return Err("That transcript is too big".into());
    }
    let target = path.with_file_name(format!("{file}.json"));
    let partial = path.with_file_name(format!(".{file}.json.partial"));
    fs::write(&partial, text).and_then(|_| fs::rename(&partial, &target)).map_err(|e| format!("Couldn't save the transcript: {e}"))
}

pub(crate) fn course(name: &str) -> Result<PathBuf, String> {
    course_dir_in(&current_root()?, name)
}

#[tauri::command]
pub fn study_lectures(course_name: String) -> Result<Vec<Lecture>, String> {
    Ok(list(&course(&course_name)?))
}

/// A recording made in the window, as the request body; the course and a name come in the
/// `x-course` and `x-name` headers, URI-encoded.
#[tauri::command]
pub fn study_save_lecture(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).and_then(crate::study::percent_decode).ok_or_else(|| format!("Missing {key}"));
    let (name, title) = (header("x-course")?, header("x-name")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Send the recording as bytes".into()) };
    save_recording(&course(&name)?, &title, bytes)
}

#[tauri::command]
pub fn study_import_lecture(course_name: String, path: String) -> Result<String, String> {
    import_recording(&course(&course_name)?, Path::new(&path))
}

#[tauri::command]
pub fn study_lecture_get(course_name: String, file: String) -> Result<Option<Value>, String> {
    Ok(read_sidecar(&course(&course_name)?, &file))
}

#[tauri::command]
pub fn study_lecture_put(course_name: String, file: String, data: Value) -> Result<(), String> {
    write_sidecar(&course(&course_name)?, &file, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recordings_and_transcripts_are_kept_in_lectures() {
        let course = std::env::temp_dir().join(format!("bd-lectures-{}", std::process::id()));
        let _ = fs::remove_dir_all(&course);
        fs::create_dir_all(&course).unwrap();
        let webm = [0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3];
        let file = save_recording(&course, "2026-10-22 Lecture 14", &webm).unwrap();
        assert_eq!(file, "2026-10-22 Lecture 14.webm");
        assert!(save_recording(&course, "x", b"not audio").is_err());
        write_sidecar(&course, &file, &serde_json::json!({ "segments": [{ "start": 0, "end": 2, "text": "Hi" }] })).unwrap();
        assert_eq!(read_sidecar(&course, &file).unwrap()["segments"][0]["text"], "Hi");
        assert!(write_sidecar(&course, "../x.webm", &serde_json::json!({})).is_err());
        assert!(write_sidecar(&course, "missing.webm", &serde_json::json!({})).is_err());
        let listed = list(&course);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].sidecar.as_ref().unwrap()["segments"][0]["end"], 2);
        let source = course.join("talk.mp3");
        fs::write(&source, b"ID3...").unwrap();
        assert_eq!(import_recording(&course, &source).unwrap(), "talk.mp3");
        assert!(import_recording(&course, &course.join("nope.txt")).is_err());
        let _ = fs::remove_dir_all(&course);
    }
}
