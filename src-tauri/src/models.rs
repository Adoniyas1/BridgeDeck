//! Speech-to-text models for lecture recording (Study tab), kept on this computer.
//!
//! Transcription runs inside BridgeDeck's own page (Transformers.js, Whisper), never on a server.
//! What it needs is downloaded once, into `<app data>/models/`, and served to the page by the
//! `bdmodel` URI scheme (that folder only):
//! - the speech engine (ONNX Runtime's WebAssembly, ~21 MB), matching the version the app was built with;
//! - a Whisper model: "fast" (tiny.en, ~40 MB) or "better" (base.en, ~80 MB), from Hugging Face.

use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

pub const SCHEME: &str = "bdmodel";

/// The ONNX Runtime build Transformers.js uses (kept in step with package.json by
/// `scripts/verify-project.mjs`); its WebAssembly is downloaded to match exactly.
pub const ORT_VERSION: &str = "1.22.0-dev.20250409-89f8206ba4";
const ORT_FILE: &str = "ort-wasm-simd-threaded.jsep.wasm";

/// The Whisper models offered: (id, Hugging Face repository, about how big).
pub const WHISPER: [(&str, &str, u32); 2] = [("fast", "onnx-community/whisper-tiny.en", 41), ("better", "onnx-community/whisper-base.en", 80)];
/// The files of a Whisper model that Transformers.js reads (8-bit, for running on the processor).
const MODEL_FILES: [&str; 7] = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
];

static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
static BUSY: Mutex<bool> = Mutex::new(false);

pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        if let Ok(mut root) = ROOT.lock() {
            *root = Some(dir.join("models"));
        }
    }
}

fn root() -> Result<PathBuf, String> {
    ROOT.lock().ok().and_then(|r| r.clone()).ok_or_else(|| "No app data folder".into())
}

fn repo_of(id: &str) -> Result<&'static str, String> {
    WHISPER.iter().find(|(i, _, _)| *i == id).map(|(_, repo, _)| *repo).ok_or_else(|| format!("No model called {id}"))
}

fn model_ready(root: &Path, repo: &str) -> bool {
    MODEL_FILES.iter().all(|f| root.join(repo).join(f).is_file())
}

fn engine_path(root: &Path) -> PathBuf {
    root.join("ort").join(ORT_VERSION).join(ORT_FILE)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsStatus {
    pub engine: bool,
    /// Which models are downloaded, by id.
    pub models: Vec<String>,
    pub downloading: bool,
}

pub fn status() -> ModelsStatus {
    let root = root().unwrap_or_default();
    ModelsStatus {
        engine: engine_path(&root).is_file(),
        models: WHISPER.iter().filter(|(_, repo, _)| model_ready(&root, repo)).map(|(id, _, _)| id.to_string()).collect(),
        downloading: BUSY.lock().map(|b| *b).unwrap_or(false),
    }
}

/// `%xx` escapes decoded (the page's addresses escape slashes too).
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A path inside the models folder from a scheme request path, or None for anything outside it.
pub fn resolve(root: &Path, request_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(request_path)?;
    let rel = Path::new(decoded.trim_start_matches('/'));
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let path = root.join(rel);
    path.is_file().then_some(path)
}

/// Serves model and engine files to BridgeDeck's page (`bdmodel://localhost/<path>`).
pub fn serve(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let fail = |status: StatusCode| Response::builder().status(status).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(Vec::new()).unwrap();
    let Ok(root) = root() else { return fail(StatusCode::NOT_FOUND) };
    let Some(path) = resolve(&root, request.uri().path()) else { return fail(StatusCode::NOT_FOUND) };
    let Ok(data) = fs::read(&path) else { return fail(StatusCode::NOT_FOUND) };
    let mime = match path.extension().and_then(|e| e.to_str()) {
        Some("wasm") => "application/wasm",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    };
    Response::builder().status(StatusCode::OK).header(header::CONTENT_TYPE, mime).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(data).unwrap()
}

fn download_file(client: &reqwest::blocking::Client, urls: &[String], to: &Path, mut progress: impl FnMut(u64)) -> Result<(), String> {
    let mut last = String::from("no address");
    for url in urls {
        match client.get(url).send().and_then(|r| r.error_for_status()) {
            Ok(mut response) => {
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let part = to.with_extension("part");
                let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
                let mut buffer = vec![0u8; 256 * 1024];
                loop {
                    let n = response.read(&mut buffer).map_err(|e| format!("Download interrupted: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    std::io::Write::write_all(&mut file, &buffer[..n]).map_err(|e| e.to_string())?;
                    progress(n as u64);
                }
                drop(file);
                return fs::rename(&part, to).map_err(|e| e.to_string());
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("Couldn't download {}: {last}", to.file_name().and_then(|n| n.to_str()).unwrap_or("a file")))
}

/// Downloads the speech engine (if missing) and the Whisper model `id`, telling the page how far
/// it got ("model-progress": downloaded and expected megabytes).
pub fn download(app: &AppHandle, id: &str) -> Result<(), String> {
    let repo = repo_of(id)?;
    let size = WHISPER.iter().find(|(i, _, _)| *i == id).map(|(_, _, s)| *s).unwrap_or(50);
    {
        let mut busy = BUSY.lock().map_err(|e| e.to_string())?;
        if *busy {
            return Err("A download is already running".into());
        }
        *busy = true;
    }
    let result = (|| {
        let root = root()?;
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(1800)).user_agent("BridgeDeck").build().map_err(|e| e.to_string())?;
        let expected = size as u64 + if engine_path(&root).is_file() { 0 } else { 21 };
        let mut done: u64 = 0;
        let mut report = |n: u64| {
            done += n;
            let _ = app.emit_to("main", "model-progress", serde_json::json!({ "model": id, "mb": done / 1_000_000, "of": expected }));
        };
        let engine = engine_path(&root);
        if !engine.is_file() {
            let urls = [
                format!("https://cdn.jsdelivr.net/npm/onnxruntime-web@{ORT_VERSION}/dist/{ORT_FILE}"),
                format!("https://unpkg.com/onnxruntime-web@{ORT_VERSION}/dist/{ORT_FILE}"),
            ];
            download_file(&client, &urls, &engine, &mut report)?;
        }
        for file in MODEL_FILES {
            let to = root.join(repo).join(file);
            if to.is_file() {
                continue;
            }
            let urls = [format!("https://huggingface.co/{repo}/resolve/main/{file}")];
            download_file(&client, &urls, &to, &mut report)?;
        }
        Ok(())
    })();
    if let Ok(mut busy) = BUSY.lock() {
        *busy = false;
    }
    result
}

// ---- Text recognition languages (scanned book pages) ----

/** Languages text recognition can read besides English, downloaded when chosen. */
pub const OCR_LANGUAGES: [&str; 13] = ["eng", "spa", "fra", "deu", "ita", "por", "rus", "ara", "hin", "chi_sim", "jpn", "kor", "amh"];

fn tessdata(root: &Path) -> PathBuf {
    root.join("tessdata")
}

/// The language files downloaded so far (codes).
pub fn ocr_languages(root: &Path) -> Vec<String> {
    OCR_LANGUAGES.iter().filter(|l| tessdata(root).join(format!("{l}.traineddata.gz")).is_file()).map(|l| l.to_string()).collect()
}

/// The `<lang>.traineddata.gz` inside a `@tesseract.js-data/<lang>` npm package.
pub fn traineddata_from_package(tgz: &[u8], lang: &str) -> Result<Vec<u8>, String> {
    let want = format!("package/4.0.0_best_int/{lang}.traineddata.gz");
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tgz));
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        if entry.path().map(|p| p.to_string_lossy() == want).unwrap_or(false) {
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
            return Ok(data);
        }
    }
    Err(format!("The {lang} language pack had no model in it"))
}

/// Downloads the chosen languages (and English, which goes with them) for text recognition.
pub fn download_ocr_languages(langs: &[String]) -> Result<Vec<String>, String> {
    let root = root()?;
    let dir = tessdata(&root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(600)).user_agent("BridgeDeck").build().map_err(|e| e.to_string())?;
    let wanted: Vec<&str> = std::iter::once("eng").chain(langs.iter().map(String::as_str)).collect();
    for lang in wanted {
        if !OCR_LANGUAGES.contains(&lang) {
            return Err(format!("No language called {lang}"));
        }
        let to = dir.join(format!("{lang}.traineddata.gz"));
        if to.is_file() {
            continue;
        }
        let url = format!("https://registry.npmjs.org/@tesseract.js-data/{lang}/-/{lang}-1.0.0.tgz");
        let tgz = client.get(&url).send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes()).map_err(|e| format!("Couldn't download the {lang} language: {e}"))?;
        let data = traineddata_from_package(&tgz, lang)?;
        let part = to.with_extension("part");
        fs::write(&part, data).map_err(|e| e.to_string())?;
        fs::rename(&part, &to).map_err(|e| e.to_string())?;
    }
    Ok(ocr_languages(&root))
}

#[tauri::command]
pub fn ocr_languages_status() -> Vec<String> {
    root().map(|r| ocr_languages(&r)).unwrap_or_default()
}

#[tauri::command]
pub async fn ocr_languages_download(languages: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || download_ocr_languages(&languages)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn models_status() -> ModelsStatus {
    status()
}

#[tauri::command]
pub async fn models_download(app: AppHandle, model: String) -> Result<ModelsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || download(&app, &model)).await.map_err(|e| e.to_string())??;
    Ok(status())
}

#[tauri::command]
pub fn models_remove(model: String) -> Result<ModelsStatus, String> {
    let repo = repo_of(&model)?;
    let _ = fs::remove_dir_all(root()?.join(repo));
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_files_in_the_models_folder() {
        let root = std::env::temp_dir().join(format!("bd-models-{}", std::process::id()));
        fs::create_dir_all(root.join("onnx-community/whisper-tiny.en/onnx")).unwrap();
        fs::write(root.join("onnx-community/whisper-tiny.en/config.json"), "{}").unwrap();
        assert!(resolve(&root, "/onnx-community/whisper-tiny.en/config.json").is_some());
        assert!(resolve(&root, "/onnx-community%2Fwhisper-tiny.en%2Fconfig.json").is_some(), "escaped slashes");
        assert!(resolve(&root, "/../secret").is_none());
        assert!(resolve(&root, "/onnx-community/whisper-tiny.en/missing.json").is_none());
        assert!(!model_ready(&root, "onnx-community/whisper-tiny.en"));

        // A language pack as npm publishes it: package/4.0.0_best_int/<lang>.traineddata.gz.
        let mut tgz = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut tgz, flate2::Compression::fast());
            let mut builder = tar::Builder::new(gz);
            for (name, body) in [("package/4.0.0/amh.traineddata.gz", &b"fast"[..]), ("package/4.0.0_best_int/amh.traineddata.gz", &b"best"[..])] {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, body).unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap();
        }
        assert_eq!(traineddata_from_package(&tgz, "amh").unwrap(), b"best");
        assert!(traineddata_from_package(&tgz, "spa").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
