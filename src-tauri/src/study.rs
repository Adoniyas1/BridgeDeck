//! The Study library: one folder per course with its textbooks, inside the folder the paired
//! computers already sync (`BridgeDeck Shared/Study/<Course>/`), so a book added on one computer
//! arrives on the other. Course notes, chapter checklists and highlights are ordinary notes in the
//! `Study/<Course>` folder; exams are calendar events.
//!
//! Books are read through the `bdbook` URI scheme, which serves files from the library and nothing
//! else (paths are checked after resolving links and `..`).
//!
//! For search (and Mimir's answers with page references) each computer keeps the text of every page
//! of its books in an index in its app data folder. The text is taken out by pdf.js in the window
//! (`study/indexer.ts`) and stored here; pages are found with BM25 ranking.

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};
use tauri::Manager;

pub const SCHEME: &str = "bdbook";
const BOOK_EXTENSIONS: &[&str] = &["pdf", "epub"];
/// Slides kept with a course: read as the PDF made from them (study_slides.rs), or opened in the
/// computer's own app. PDF slides are books.
const SLIDE_EXTENSIONS: &[&str] = &["pptx", "ppt", "key", "odp"];
/// Photos of notes and whiteboards kept with a course (shown, and read by text recognition).
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "heic", "webp"];
/// In a course folder: the course is archived (hidden from the list, files kept). It syncs, so
/// both computers agree.
const ARCHIVED: &str = ".archived";

/// The library folder, remembered for the `bdbook` scheme.
static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
/// Where the page text of the books is kept (`<app data>/study-index`).
static INDEX_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
/// Page text already read from disk, by index file (dropped when the file changes).
static INDEX_CACHE: Mutex<Option<HashMap<PathBuf, (SystemTime, Arc<BookText>)>>> = Mutex::new(None);
/// The most text kept for one book (about 25 large textbooks' worth in all is fine).
const MAX_INDEX_BYTES: usize = 40 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    /// File name inside the course folder.
    pub file: String,
    pub title: String,
    /// "pdf" or "epub", or a presentation's extension ("pptx", "key"…).
    pub kind: String,
    pub bytes: u64,
    /// Its page text is in the search index ("pdf" only).
    #[serde(default)]
    pub indexed: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Course {
    pub name: String,
    pub books: Vec<Book>,
    #[serde(default)]
    pub archived: bool,
    /// From `.course.json` in the folder (synced, so both computers agree).
    #[serde(default)]
    pub info: CourseInfo,
}

/// What a course is beyond its folder name: its catalog code and title ("MATH 224", "Calculus 3")
/// and the Canvas course it's linked to, so Canvas assignments land in it whatever the names.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CourseInfo {
    pub code: String,
    pub title: String,
    pub canvas_id: String,
    pub canvas_code: String,
    /// The rest is kept as the Study tab wrote it: class times ("meetings") and grading.
    #[serde(flatten)]
    pub more: serde_json::Map<String, serde_json::Value>,
}

const INFO: &str = ".course.json";
/// The degree plan (which courses are done, being taken, chosen for electives), beside the courses.
const PLAN: &str = ".degree-plan.json";
const MAX_PLAN: usize = 256 * 1024;

fn read_info(dir: &Path) -> CourseInfo {
    merge_info_conflicts(dir);
    fs::read(dir.join(INFO)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn read_info_map(path: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    fs::read(path).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()).and_then(|v| v.as_object().cloned())
}

/// The two computers changed a course's settings while apart, so Syncthing kept both
/// (`.course.sync-conflict-<date>-<time>-<device>.json`). Settings only one of them has are kept;
/// for a setting both changed, the newer file's wins. The copy then goes to the Trash.
fn merge_info_conflicts(dir: &Path) {
    let main = dir.join(INFO);
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if crate::sync_conflicts::original_name(&name).as_deref() != Some(INFO) {
            continue;
        }
        let Some(theirs) = read_info_map(&entry.path()) else { continue };
        let mine = read_info_map(&main).unwrap_or_default();
        let time = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
        let merged = merge_info(mine, theirs, time(&entry.path()) > time(&main));
        let Ok(bytes) = serde_json::to_vec_pretty(&serde_json::Value::Object(merged)) else { continue };
        if write_atomic(&main, &bytes).is_ok() {
            let _ = trash::delete(entry.path());
        }
    }
}

/// `mine` with the settings only `theirs` has; where both have one, `theirs` when it's newer.
fn merge_info(mut mine: serde_json::Map<String, serde_json::Value>, theirs: serde_json::Map<String, serde_json::Value>, theirs_newer: bool) -> serde_json::Map<String, serde_json::Value> {
    for (key, value) in theirs {
        if theirs_newer || !mine.contains_key(&key) {
            mine.insert(key, value);
        }
    }
    mine
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let partial = path.with_extension("json.partial");
    fs::write(&partial, bytes).and_then(|_| fs::rename(&partial, path)).map_err(|e| e.to_string())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub root: String,
    pub courses: Vec<Course>,
}

pub(crate) fn default_shared() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join("BridgeDeck Shared")
}

/// `<shared folder>/Study`.
fn root_for(shared: &str) -> PathBuf {
    let shared = if shared.trim().is_empty() { default_shared() } else { PathBuf::from(shared.trim()) };
    shared.join("Study")
}

/// A course or book name made safe as a single folder or file name.
pub(crate) fn clean_name(name: &str) -> Result<String, String> {
    let cleaned: String = name.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c }).collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().chars().take(100).collect::<String>();
    if cleaned.is_empty() { Err("Give it a name".into()) } else { Ok(cleaned) }
}

fn title_of(file: &str) -> String {
    Path::new(file).file_stem().map(|s| s.to_string_lossy().replace(['_', '-'], " ")).unwrap_or_default().trim().to_string()
}

fn book_kind(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    (BOOK_EXTENSIONS.contains(&ext.as_str()) || SLIDE_EXTENSIONS.contains(&ext.as_str()) || IMAGE_EXTENSIONS.contains(&ext.as_str())).then_some(ext)
}

pub fn init(app: &tauri::AppHandle) {
    if let (Ok(dir), Ok(mut stored)) = (app.path().app_data_dir(), INDEX_DIR.lock()) {
        crate::study_slides::init(&dir);
        *stored = Some(dir.join("study-index"));
    }
}

pub fn read_library(root: &Path) -> Result<Library, String> {
    fs::create_dir_all(root).map_err(|e| format!("Can't use the Study folder {}: {e}", root.display()))?;
    let mut courses = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())?.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mut books: Vec<Book> = fs::read_dir(entry.path())
            .map(|dir| dir.filter_map(Result::ok).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .filter(|f| f.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter_map(|f| {
                let kind = book_kind(&f.path())?;
                let file = f.file_name().to_string_lossy().to_string();
                let bytes = f.metadata().map(|m| m.len()).unwrap_or(0);
                Some(Book { indexed: index_dir().is_some_and(|dir| load_text(&dir, &name, &file).is_some_and(|t| t.bytes == bytes && t.version >= INDEX_VERSION)), title: title_of(&file), file, kind, bytes })
            })
            .collect();
        books.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        let archived = entry.path().join(ARCHIVED).exists();
        let info = read_info(&entry.path());
        courses.push(Course { name, books, archived, info });
    }
    courses.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(Library { root: root.to_string_lossy().to_string(), courses })
}

fn remember(root: &Path) {
    if let Ok(mut stored) = ROOT.lock() {
        *stored = Some(root.to_path_buf());
    }
}

pub(crate) fn current_root() -> Result<PathBuf, String> {
    ROOT.lock().ok().and_then(|r| r.clone()).ok_or_else(|| "Open the Study tab first".into())
}

/// The library folder: the one the Study tab last used, else the default.
pub fn root_or_default() -> PathBuf {
    current_root().unwrap_or_else(|_| root_for(""))
}

/// A free file name in `dir`: "Book.pdf", else "Book (2).pdf".
fn free_name(dir: &Path, file: &str) -> String {
    if !dir.join(file).exists() {
        return file.to_string();
    }
    let path = Path::new(file);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "book".into());
    let ext = path.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    (2..1000).map(|n| format!("{stem} ({n}).{ext}")).find(|name| !dir.join(name).exists()).unwrap_or_else(|| format!("{stem} ({}).{ext}", uuid::Uuid::new_v4()))
}

pub fn add_books(root: &Path, course: &str, paths: &[PathBuf]) -> Result<Vec<Book>, String> {
    let dir = root.join(clean_name(course)?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut added = Vec::new();
    for path in paths {
        let kind = book_kind(path).ok_or_else(|| format!("{} isn't a PDF, EPUB, presentation or photo", path.display()))?;
        let original = path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("No file name")?;
        let file = free_name(&dir, &clean_name(&original)?);
        let bytes = fs::copy(path, dir.join(&file)).map_err(|e| format!("Couldn't copy {original}: {e}"))?;
        added.push(Book { title: title_of(&file), file, kind, bytes, indexed: false });
    }
    Ok(added)
}

/// The file a `bdbook` path names, only if it is a book inside the library.
pub fn resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(url_path.trim_start_matches('/'))?;
    let parts: Vec<&str> = decoded.split('/').collect();
    // A book (`course/file`), or a flashcard picture (`course/Cards/file`, pictures only).
    let card_picture = parts.len() == 3 && parts[1] == CARDS_DIR;
    let lecture = parts.len() == 3 && parts[1] == crate::study_lectures::LECTURES_DIR;
    if !(parts.len() == 2 || card_picture || lecture) || parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('\\')) {
        return None;
    }
    let candidate = parts.iter().fold(root.to_path_buf(), |path, p| path.join(p));
    if lecture {
        let real = candidate.canonicalize().ok()?;
        return (real.starts_with(root.canonicalize().ok()?) && real.is_file() && crate::study_lectures::is_audio(&real)).then_some(real);
    }
    if card_picture && !candidate.extension().and_then(|e| e.to_str()).is_some_and(|e| CARD_PICTURES.contains(&e.to_ascii_lowercase().as_str())) {
        return None;
    }
    let real = candidate.canonicalize().ok()?;
    let real_root = root.canonicalize().ok()?;
    (real.starts_with(&real_root) && real.is_file() && book_kind(&real).is_some()).then_some(real)
}

pub(crate) fn percent_decode(text: &str) -> Option<String> {
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

/// Serves a book to the reader: the whole file, or the byte range asked for.
pub fn serve(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let fail = |status: StatusCode| Response::builder().status(status).body(Vec::new()).unwrap();
    let Ok(root) = current_root() else { return fail(StatusCode::NOT_FOUND) };
    let Some(found) = resolve(&root, request.uri().path()) else { return fail(StatusCode::NOT_FOUND) };
    let audio = crate::study_lectures::is_audio(&found);
    // A presentation is served as the PDF made from it (study_slides_pdf makes it first).
    let path = match book_kind(&found) {
        _ if audio => found,
        Some(k) if SLIDE_EXTENSIONS.contains(&k.as_str()) => match crate::study_slides::cached(&found) {
            Some(pdf) => pdf,
            None => return fail(StatusCode::NOT_FOUND),
        },
        Some(k) if BOOK_EXTENSIONS.contains(&k.as_str()) || IMAGE_EXTENSIONS.contains(&k.as_str()) => found,
        _ => return fail(StatusCode::NOT_FOUND),
    };
    let mime = if audio { crate::study_lectures::audio_mime(&path) } else { match book_kind(&path).as_deref() {
        Some("epub") => "application/epub+zip",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("heic") => "image/heic",
        Some("webp") => "image/webp",
        _ => "application/pdf",
    } };
    let Ok(mut file) = fs::File::open(&path) else { return fail(StatusCode::NOT_FOUND) };
    let Ok(total) = file.metadata().map(|m| m.len()) else { return fail(StatusCode::NOT_FOUND) };
    // pdf.js reads a big book in pieces: these let the window see that it can.
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Accept-Ranges, Content-Range, Content-Length");
    if request.method() == tauri::http::Method::OPTIONS {
        return builder.status(StatusCode::NO_CONTENT).body(Vec::new()).unwrap();
    }
    // A header that isn't a byte range is ignored, as HTTP says.
    let header = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).filter(|h| h.trim().starts_with("bytes="));
    match header.map(|h| parse_range(h, total)) {
        // Only the part asked for is read, not the whole book.
        Some(Some((start, end))) => {
            use std::io::{Read, Seek, SeekFrom};
            let mut part = vec![0; (end - start + 1) as usize];
            if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut part)).is_err() {
                return fail(StatusCode::INTERNAL_SERVER_ERROR);
            }
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
                .header(header::CONTENT_LENGTH, part.len())
                .body(part)
                .unwrap()
        }
        Some(None) => builder.status(StatusCode::RANGE_NOT_SATISFIABLE).header(header::CONTENT_RANGE, format!("bytes */{total}")).body(Vec::new()).unwrap(),
        None => {
            let Ok(data) = fs::read(&path) else { return fail(StatusCode::NOT_FOUND) };
            builder.status(StatusCode::OK).header(header::CONTENT_LENGTH, data.len()).body(data).unwrap()
        }
    }
}

/// The bytes a `Range: bytes=…` header asks for in a file of `total` bytes, as an inclusive
/// (start, end): "a-b", "a-" (to the end) or "-n" (the last n). One range only; past the end is cut
/// to the end; None when nothing of the file is asked for. Parts are at most 16 MB.
fn parse_range(header: &str, total: u64) -> Option<(u64, u64)> {
    const MAX_PART: u64 = 16 * 1024 * 1024;
    let (a, b) = header.trim().strip_prefix("bytes=")?.split_once('-')?;
    if total == 0 || b.contains(',') {
        return None;
    }
    let last = total - 1;
    let (start, end) = if a.trim().is_empty() {
        let n: u64 = b.trim().parse().ok()?;
        if n == 0 {
            return None;
        }
        (total.saturating_sub(n), last)
    } else {
        let start: u64 = a.trim().parse().ok()?;
        let end = if b.trim().is_empty() { last } else { b.trim().parse::<u64>().ok()?.min(last) };
        (start, end)
    };
    (start <= end && start <= last).then_some((start, end.min(start + MAX_PART - 1)))
}

// ---- PDFs made here ----

const MAX_MADE_PDF: usize = 500 * 1024 * 1024;

/// Saves a PDF made in the window (stitched pages) into a course as `<name>.pdf` (a free name, so
/// nothing is replaced). Returns the file name it got.
fn save_pdf(dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    if !bytes.starts_with(b"%PDF-") || bytes.len() > MAX_MADE_PDF {
        return Err("That isn't a PDF BridgeDeck can save".into());
    }
    let stem = clean_name(name.trim().trim_end_matches(".pdf").trim_end_matches(".PDF"))?;
    let file = free_name(dir, &format!("{stem}.pdf"));
    let path = dir.join(&file);
    let partial = dir.join(format!(".{file}.partial"));
    fs::write(&partial, bytes).and_then(|_| fs::rename(&partial, &path)).map_err(|e| format!("Couldn't save the PDF: {e}"))?;
    Ok(file)
}

/// Writes a PDF made here (a book, a chapter, some pages) where the person chose in the save dialog.
/// Only a .pdf file in a folder that exists, and only PDF bytes.
fn write_download(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"%PDF-") || bytes.len() > MAX_MADE_PDF {
        return Err("That isn't a PDF".into());
    }
    let pdf = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if !path.is_absolute() || !pdf || !path.parent().is_some_and(Path::is_dir) {
        return Err("Choose where to save it as a .pdf file".into());
    }
    let partial = path.with_extension("pdf.partial");
    fs::write(&partial, bytes).and_then(|_| fs::rename(&partial, path)).map_err(|e| format!("Couldn't save it: {e}"))
}

/// The bytes are the request body; the path (from the save dialog) is in `x-path`, URI-encoded.
#[tauri::command]
pub fn study_download_pdf(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).and_then(percent_decode).ok_or("Missing x-path")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Send the PDF as bytes".into()) };
    write_download(Path::new(&path), bytes)
}

/// The courses being taken (not archived), for the phone's scan page.
pub fn course_names() -> Vec<String> {
    read_library(&root_or_default()).map(|l| l.courses.into_iter().filter(|c| !c.archived).map(|c| c.name).collect()).unwrap_or_default()
}

/// Saves a PDF made elsewhere (the phone's scans) into a course; returns the file name it got.
pub fn save_pdf_in(course: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = course_dir(&root_or_default(), course)?;
    save_pdf(&dir, name, bytes)
}

// ---- Flashcard pictures ----

/// A course's folder of pictures used on flashcards.
pub const CARDS_DIR: &str = "Cards";
const CARD_PICTURES: &[&str] = &["png", "jpg", "jpeg", "webp"];
const MAX_CARD_PICTURE: usize = 15 * 1024 * 1024;

/// The picture's kind from its first bytes (the name isn't trusted).
fn picture_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// Saves a picture in `<course>/Cards/` and returns its file name.
fn save_card_picture(course_dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let kind = picture_kind(bytes).filter(|_| bytes.len() <= MAX_CARD_PICTURE).ok_or("Only PNG, JPEG or WebP pictures up to 15 MB")?;
    let dir = course_dir.join(CARDS_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = Path::new(name.trim()).file_stem().and_then(|s| s.to_str()).unwrap_or("picture");
    let file = free_name(&dir, &format!("{}.{kind}", clean_name(stem).unwrap_or_else(|_| "picture".into())));
    let partial = dir.join(format!(".{file}.partial"));
    fs::write(&partial, bytes).and_then(|_| fs::rename(&partial, dir.join(&file))).map_err(|e| format!("Couldn't save the picture: {e}"))?;
    Ok(file)
}

/// A picture for a flashcard, sent as the request body; the course and a name come in the
/// `x-course` and `x-name` headers, URI-encoded.
#[tauri::command]
pub fn study_save_card_picture(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).and_then(percent_decode).ok_or_else(|| format!("Missing {key}"));
    let (course, name) = (header("x-course")?, header("x-name")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Send the picture as bytes".into()) };
    save_card_picture(&course_dir(&current_root()?, &course)?, &name, bytes)
}

/// Saves a course's flashcards as a CSV file in its folder and returns the file name.
#[tauri::command]
pub fn study_save_csv(course: String, name: String, text: String) -> Result<String, String> {
    save_csv(&course_dir(&current_root()?, &course)?, &name, &text)
}

fn save_csv(dir: &Path, name: &str, text: &str) -> Result<String, String> {
    if text.len() > 20 * 1024 * 1024 {
        return Err("That's too much to save".into());
    }
    let stem = clean_name(name.trim().trim_end_matches(".csv"))?;
    let file = free_name(dir, &format!("{stem}.csv"));
    let partial = dir.join(format!(".{file}.partial"));
    fs::write(&partial, text).and_then(|_| fs::rename(&partial, dir.join(&file))).map_err(|e| format!("Couldn't save it: {e}"))?;
    Ok(file)
}

/// A photo made here (a page straightened from a photo), as the request body; the course and a
/// name in the `x-course` and `x-name` headers, URI-encoded. JPEG or PNG only.
#[tauri::command]
pub fn study_save_photo(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).and_then(percent_decode).ok_or_else(|| format!("Missing {key}"));
    let (course, name) = (header("x-course")?, header("x-name")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Send the photo as bytes".into()) };
    let kind = picture_kind(bytes).filter(|k| *k != "webp" && bytes.len() <= MAX_CARD_PICTURE).ok_or("Only JPEG or PNG photos up to 15 MB")?;
    let dir = course_dir(&current_root()?, &course)?;
    let stem = Path::new(name.trim()).file_stem().and_then(|s| s.to_str()).unwrap_or("Scan");
    save_course_file(&dir, None, &format!("{stem}.{kind}"), bytes)
}

/// A HEIC photo in a course turned into a JPEG in its place (src/heic.rs), so every part of the
/// Study tab can read it. Returns the JPEG's file name.
#[tauri::command]
pub async fn study_convert_heic(course: String, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = course_dir(&current_root()?, &course)?;
        let clean = clean_name(&file)?;
        if !clean.to_lowercase().ends_with(".heic") || !dir.join(&clean).is_file() {
            return Err("No such HEIC photo".into());
        }
        let jpeg = crate::heic::to_jpeg(&dir.join(&clean))?;
        let stem = Path::new(&clean).file_stem().and_then(|s| s.to_str()).unwrap_or("Photo");
        let saved = save_course_file(&dir, None, &format!("{stem}.jpg"), &jpeg)?;
        let _ = fs::remove_file(dir.join(&clean));
        crate::activity::info("study", &format!("Converted {clean} to {saved} in {course}."));
        Ok(saved)
    }).await.map_err(|e| e.to_string())?
}

/// The PDF is sent as the request body (not JSON); the course and file name come in the
/// `x-course` and `x-name` headers, URI-encoded.
#[tauri::command]
pub fn study_save_pdf(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).and_then(percent_decode).ok_or_else(|| format!("Missing {key}"));
    let (course, name) = (header("x-course")?, header("x-name")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Send the PDF as bytes".into()) };
    let dir = course_dir(&current_root()?, &course)?;
    let file = save_pdf(&dir, &name, bytes)?;
    crate::activity::info("study", &format!("Saved {file} in {course}."));
    Ok(file)
}

// ---- Export a semester ----

/// The files a semester export carries, by path under `root`: every file of the courses being
/// taken (not archived), and the Study-wide state (the term, degree plan, `.state`). Hidden
/// folders inside a course (caches) and partial writes are left out.
fn semester_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for name in [".term.json", ".degree-plan.json"] {
        if root.join(name).is_file() {
            out.push(PathBuf::from(name));
        }
    }
    let walk = |dir: &Path, out: &mut Vec<PathBuf>, skip_hidden_dirs: bool| {
        for entry in walkdir::WalkDir::new(dir).follow_links(false).into_iter().filter_entry(|e| e.depth() == 0 || !skip_hidden_dirs || !e.file_type().is_dir() || !e.file_name().to_string_lossy().starts_with('.')).flatten() {
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_file() && !name.ends_with(".partial") && !name.contains(".sync-conflict-") {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    out.push(rel.to_path_buf());
                }
            }
        }
    };
    walk(&root.join(".state"), &mut out, false);
    for course in fs::read_dir(root).into_iter().flatten().flatten() {
        let name = course.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !course.path().is_dir() || course.path().join(ARCHIVED).exists() {
            continue;
        }
        walk(&course.path(), &mut out, true);
    }
    out.sort();
    out
}

/// Writes the semester (see `semester_files`) as a zip at `to`. Returns how many files went in.
fn export_semester(root: &Path, to: &Path) -> Result<usize, String> {
    use std::io::Write;
    let files = semester_files(root);
    let file = fs::File::create(to).map_err(|e| format!("Couldn't write {}: {e}", to.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    for rel in &files {
        // Books, pictures and recordings are compressed already.
        let packed = book_kind(rel).is_some_and(|k| BOOK_EXTENSIONS.contains(&k.as_str()) || IMAGE_EXTENSIONS.contains(&k.as_str()) || matches!(k.as_str(), "mp3" | "m4a" | "webm" | "mp4" | "zip"));
        let method = if packed { zip::CompressionMethod::Stored } else { zip::CompressionMethod::Deflated };
        let opts = zip::write::SimpleFileOptions::default().compression_method(method).large_file(true);
        let mut source = fs::File::open(root.join(rel)).map_err(|e| format!("Couldn't read {}: {e}", rel.display()))?;
        zip.start_file(format!("Study/{}", rel.to_string_lossy().replace('\\', "/")), opts).map_err(|e| e.to_string())?;
        std::io::copy(&mut source, &mut zip).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
    Ok(files.len())
}

/// Saves this semester's courses (books, notes files, recordings, settings) and Study's state in
/// one .zip at `path`: for keeping before finals, or moving to a new computer.
#[tauri::command]
pub async fn study_export_semester(path: String) -> Result<String, String> {
    let root = current_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let n = export_semester(&root, Path::new(&path))?;
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        crate::activity::info("study", &format!("Exported the semester to {path} ({n} files)."));
        Ok(format!("Saved {n} file{} ({:.1} MB) in {path}.", if n == 1 { "" } else { "s" }, size as f64 / 1_048_576.0))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Page text and search ----

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BookText {
    /// The book's size when its text was taken; a different size means a new edition to read again.
    pub bytes: u64,
    /// The text of each page; page 1 first.
    pub pages: Vec<String>,
    /// How the text was read; older indexes are read again (2 added text recognition for scanned pages).
    #[serde(default)]
    pub version: u32,
}

/// The current way of reading books for search.
pub const INDEX_VERSION: u32 = 2;

#[cfg(test)]
pub fn set_index_dir(dir: PathBuf) {
    *INDEX_DIR.lock().unwrap() = Some(dir);
}

fn index_dir() -> Option<PathBuf> {
    INDEX_DIR.lock().ok().and_then(|d| d.clone())
}

fn index_path(dir: &Path, course: &str, file: &str) -> PathBuf {
    dir.join(course).join(format!("{file}.json"))
}

pub fn save_text(dir: &Path, course: &str, file: &str, text: &BookText) -> Result<(), String> {
    let size: usize = text.pages.iter().map(String::len).sum();
    if size > MAX_INDEX_BYTES {
        return Err("That book has more text than BridgeDeck keeps for search".into());
    }
    let path = index_path(dir, course, file);
    fs::create_dir_all(path.parent().unwrap_or(dir)).map_err(|e| e.to_string())?;
    let raw = serde_json::to_vec(text).map_err(|e| e.to_string())?;
    let partial = path.with_extension("part");
    fs::write(&partial, raw).map_err(|e| e.to_string())?;
    fs::rename(&partial, &path).map_err(|e| e.to_string())
}

pub fn load_text(dir: &Path, course: &str, file: &str) -> Option<Arc<BookText>> {
    let path = index_path(dir, course, file);
    let modified = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    let mut cache = INDEX_CACHE.lock().ok()?;
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some((when, text)) = cache.get(&path) {
        if *when == modified {
            return Some(text.clone());
        }
    }
    let text: Arc<BookText> = Arc::new(serde_json::from_slice(&fs::read(&path).ok()?).ok()?);
    cache.insert(path, (modified, text.clone()));
    Some(text)
}

const STOP_WORDS: &[&str] = &["the", "and", "for", "are", "was", "were", "with", "that", "this", "from", "into", "what", "which", "how", "why", "does", "is", "of", "to", "in", "on", "an", "a", "be", "by", "it", "as", "or", "at", "its", "can", "do"];

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 2).map(str::to_lowercase).filter(|w| !STOP_WORDS.contains(&w.as_str())).collect()
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub course: String,
    pub book: String,
    pub file: String,
    pub page: usize,
    pub snippet: String,
    pub score: f64,
    /// "book", "lecture" (`t`: seconds into the recording) or "note" (`file` is the note's id).
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t: Option<u64>,
}

/// A course note to search with the books: its course, title, id and text.
pub struct NoteDoc {
    pub course: String,
    pub title: String,
    pub id: String,
    pub text: String,
}

/// One searchable piece: a book page, a minute of a lecture, or a note.
struct Piece {
    course: String,
    title: String,
    file: String,
    page: usize,
    kind: &'static str,
    t: Option<u64>,
    text: Arc<str>,
}

/// A lecture's transcript in pieces of about a minute, each with its start (seconds).
fn lecture_minutes(sidecar: &serde_json::Value) -> Vec<(u64, String)> {
    let mut out: Vec<(u64, String)> = Vec::new();
    for s in sidecar["segments"].as_array().into_iter().flatten() {
        let start = s["start"].as_f64().unwrap_or(0.0).max(0.0) as u64;
        let text = s["text"].as_str().unwrap_or("").trim();
        match out.last_mut() {
            Some((at, body)) if start < *at + 60 => {
                body.push(' ');
                body.push_str(text);
            }
            _ => out.push((start, text.to_string())),
        }
    }
    out
}

/// The passage of `text` around the first of `terms` it contains.
fn snippet(text: &str, terms: &HashSet<String>, width: usize) -> String {
    let lower = text.to_lowercase();
    // Lower-casing can change byte lengths; only use the position when it lines up.
    let at = terms.iter().filter_map(|t| lower.find(t.as_str())).min().filter(|_| lower.len() == text.len()).unwrap_or(0);
    let mut start = at.saturating_sub(width / 3);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + width).min(text.len());
    while !text.is_char_boundary(end) {
        end += 1;
    }
    let body = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{body}{}", if start > 0 { "…" } else { "" }, if end < text.len() { "…" } else { "" })
}

/// The pages that best answer `query`, best first (BM25 over every page of the books in scope, each
/// minute of their lecture transcripts, and the course notes given).
pub fn search(library: &Library, dir: &Path, query: &str, course: Option<&str>, limit: usize, notes: &[NoteDoc]) -> Vec<Hit> {
    let terms: HashSet<String> = words(query).into_iter().collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let wanted = course.map(str::to_lowercase).filter(|c| !c.trim().is_empty());
    let in_scope = |name: &str| wanted.as_ref().is_none_or(|w| name.to_lowercase().contains(w.as_str()));
    let mut pieces: Vec<Piece> = Vec::new();
    let root = Path::new(&library.root);
    for c in library.courses.iter().filter(|c| in_scope(&c.name)) {
        for b in &c.books {
            if let Some(text) = load_text(dir, &c.name, &b.file) {
                for (i, page) in text.pages.iter().enumerate() {
                    pieces.push(Piece { course: c.name.clone(), title: b.title.clone(), file: b.file.clone(), page: i + 1, kind: "book", t: None, text: Arc::from(page.as_str()) });
                }
            }
        }
        for lecture in crate::study_lectures::list(&root.join(&c.name)) {
            let Some(sidecar) = lecture.sidecar else { continue };
            let title = lecture.file.rsplit_once('.').map(|(stem, _)| stem.to_string()).unwrap_or_else(|| lecture.file.clone());
            for (i, (t, text)) in lecture_minutes(&sidecar).into_iter().enumerate() {
                pieces.push(Piece { course: c.name.clone(), title: title.clone(), file: lecture.file.clone(), page: i + 1, kind: "lecture", t: Some(t), text: Arc::from(text.as_str()) });
            }
        }
    }
    for n in notes.iter().filter(|n| in_scope(&n.course)) {
        pieces.push(Piece { course: n.course.clone(), title: n.title.clone(), file: n.id.clone(), page: 1, kind: "note", t: None, text: Arc::from(n.text.as_str()) });
    }
    let counted: Vec<HashMap<String, usize>> = pieces
        .iter()
        .map(|piece| {
            let mut counts = HashMap::new();
            let all = words(&piece.text);
            counts.insert(String::new(), all.len());
            for w in all.into_iter().filter(|w| terms.contains(w)) {
                *counts.entry(w).or_insert(0) += 1;
            }
            counts
        })
        .collect();
    let n = pieces.len() as f64;
    let average = (counted.iter().map(|c| c[""] as f64).sum::<f64>() / n.max(1.0)).max(1.0);
    let (k1, b) = (1.2, 0.75);
    let mut scored: Vec<(f64, usize)> = counted
        .iter()
        .enumerate()
        .map(|(index, counts)| {
            let length = counts[""] as f64;
            let score = terms
                .iter()
                .map(|t| {
                    let tf = *counts.get(t).unwrap_or(&0) as f64;
                    if tf == 0.0 {
                        return 0.0;
                    }
                    let df = counted.iter().filter(|c| c.contains_key(t)).count() as f64;
                    let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                    idf * tf * (k1 + 1.0) / (tf + k1 * (1.0 - b + b * length / average))
                })
                .sum::<f64>();
            (score, index)
        })
        .filter(|(score, _)| *score > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored
        .into_iter()
        .take(limit)
        .map(|(score, index)| {
            let p = &pieces[index];
            Hit { course: p.course.clone(), book: p.title.clone(), file: p.file.clone(), page: p.page, snippet: snippet(&p.text, &terms, 360), score: (score * 100.0).round() / 100.0, kind: p.kind, t: p.t }
        })
        .collect()
}

/// A course by its name or part of it.
pub fn find_course<'a>(library: &'a Library, name: &str) -> Option<&'a Course> {
    let wanted = name.trim().to_lowercase();
    library.courses.iter().find(|c| c.name.to_lowercase() == wanted).or_else(|| library.courses.iter().find(|c| c.name.to_lowercase().contains(&wanted)))
}

/// A book of a course by its file name or (part of) its title.
pub fn find_book<'a>(course: &'a Course, name: &str) -> Option<&'a Book> {
    let wanted = name.trim().to_lowercase();
    course
        .books
        .iter()
        .find(|b| b.file.to_lowercase() == wanted || b.title.to_lowercase() == wanted)
        .or_else(|| course.books.iter().find(|b| b.title.to_lowercase().contains(&wanted) || b.file.to_lowercase().contains(&wanted)))
}

/// The library and its index folder, for Mimir.
pub fn library_for_search() -> Result<(Library, PathBuf), String> {
    let dir = index_dir().ok_or("The study index isn't ready")?;
    Ok((read_library(&root_or_default())?, dir))
}

// ---- Commands ----

/// The library in `shared` (the synced folder; empty means the default).
#[tauri::command]
pub fn study_library(shared: String) -> Result<Library, String> {
    let root = root_for(&shared);
    remember(&root);
    read_library(&root)
}

#[tauri::command]
pub fn study_add_course(name: String) -> Result<(), String> {
    let root = current_root()?;
    fs::create_dir_all(root.join(clean_name(&name)?)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn study_add_books(course: String, paths: Vec<String>) -> Result<Vec<Book>, String> {
    let root = current_root()?;
    add_books(&root, &course, &paths.into_iter().map(PathBuf::from).collect::<Vec<_>>())
}

/// The folder of a course in the library (it must be there).
/// Whether a file name is one the library lists (a book, slides or a picture).
pub fn is_library_file(name: &str) -> bool {
    book_kind(Path::new(name)).is_some()
}

/// Saves a downloaded file in a course: over the copy it replaces (`previous`), else under a free
/// name. Returns the file name.
pub fn save_course_file(dir: &Path, previous: Option<&str>, name: &str, bytes: &[u8]) -> Result<String, String> {
    let clean = clean_name(name)?;
    if !is_library_file(&clean) {
        return Err("Not a file the Study tab keeps".into());
    }
    let file = match previous.and_then(|p| clean_name(p).ok()).filter(|p| dir.join(p).is_file()) {
        Some(p) => p,
        None => free_name(dir, &clean),
    };
    let partial = dir.join(format!(".{file}.partial"));
    fs::write(&partial, bytes).and_then(|_| fs::rename(&partial, dir.join(&file))).map_err(|e| format!("Couldn't save {file}: {e}"))?;
    Ok(file)
}

pub(crate) fn course_dir_in(root: &Path, name: &str) -> Result<PathBuf, String> {
    course_dir(root, name)
}

pub(crate) fn free_name_in(dir: &Path, file: &str) -> String {
    free_name(dir, file)
}

fn course_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    let dir = root.join(clean_name(name)?);
    if clean_name(name)? != name || !dir.is_dir() {
        return Err("No such course".into());
    }
    Ok(dir)
}

/// Archives a course (hidden from the list, its files kept) or brings it back.
#[tauri::command]
pub fn study_archive_course(name: String, archived: bool) -> Result<(), String> {
    let marker = course_dir(&current_root()?, &name)?.join(ARCHIVED);
    if archived {
        fs::write(marker, "Archived in BridgeDeck's Study tab; delete this file to bring the course back.\n").map_err(|e| e.to_string())
    } else {
        match fs::remove_file(marker) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/// Changes some of a course's settings (code, title, Canvas course, class times, grading…): the
/// settings in `patch` replace those in the file as it is now (null removes one), and the rest stay
/// as they are, so a change here doesn't undo one just synced from the other computer.
#[tauri::command]
pub fn study_patch_course_info(name: String, patch: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let dir = course_dir(&current_root()?, &name)?;
    patch_info(&dir, patch)
}

fn patch_info(dir: &Path, patch: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    merge_info_conflicts(dir);
    let mut info = read_info_map(&dir.join(INFO)).unwrap_or_default();
    for (key, value) in patch {
        if key.is_empty() || key.len() > 64 {
            return Err("Not a course setting".into());
        }
        match value {
            serde_json::Value::Null => { info.remove(&key); }
            // The names are short text.
            serde_json::Value::String(text) if matches!(key.as_str(), "code" | "title" | "canvasId" | "canvasCode") => {
                info.insert(key, serde_json::Value::String(text.trim().chars().take(120).collect()));
            }
            value => { info.insert(key, value); }
        }
    }
    // Still a course's settings (the names are text).
    serde_json::from_value::<CourseInfo>(serde_json::Value::Object(info.clone())).map_err(|_| "Not a course setting")?;
    let bytes = serde_json::to_vec_pretty(&serde_json::Value::Object(info)).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_PLAN {
        return Err("Too much to keep for one course".into());
    }
    write_atomic(&dir.join(INFO), &bytes)
}

// The term and ticked problems are kept in study_state.rs.

/// The degree plan's saved state (JSON), empty when there's none yet.
#[tauri::command]
pub fn study_plan_read() -> Result<String, String> {
    match fs::read_to_string(current_root()?.join(PLAN)) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn study_plan_write(text: String) -> Result<(), String> {
    if text.len() > MAX_PLAN || serde_json::from_str::<serde_json::Value>(&text).is_err() {
        return Err("Not a degree plan".into());
    }
    fs::write(current_root()?.join(PLAN), text).map_err(|e| e.to_string())
}

/// Deletes a course: its folder goes to the Trash (and off the other computer, which syncs it).
#[tauri::command]
pub fn study_delete_course(name: String) -> Result<(), String> {
    let dir = course_dir(&current_root()?, &name)?;
    trash::delete(&dir).or_else(|_| fs::remove_dir_all(&dir)).map_err(|e| format!("Couldn't delete the course: {e}"))?;
    if let Some(index) = index_dir() {
        let _ = fs::remove_dir_all(index.join(clean_name(&name)?));
    }
    Ok(())
}

/// Removes a book from the course (and so from the other computer too).
#[tauri::command]
pub fn study_remove_book(course: String, file: String) -> Result<(), String> {
    let root = current_root()?;
    let path = resolve(&root, &format!("{}/{}", course, file)).ok_or("No such book")?;
    fs::remove_file(path).map_err(|e| e.to_string())?;
    if let Some(dir) = index_dir() {
        let _ = fs::remove_file(index_path(&dir, &course, &file));
    }
    crate::study_slides::forget(&course, &file);
    Ok(())
}

/// Makes the PDF the reader shows for a presentation (PowerPoint, Keynote…), unless it has one.
/// The first time takes a few seconds: an app on this computer does the conversion.
#[tauri::command]
pub async fn study_slides_pdf(course: String, file: String) -> Result<(), String> {
    let root = current_root()?;
    let path = resolve(&root, &format!("{}/{}", course, file)).ok_or("No such presentation")?;
    if !book_kind(&path).is_some_and(|k| SLIDE_EXTENSIONS.contains(&k.as_str())) {
        return Err("Not a presentation".into());
    }
    tauri::async_runtime::spawn_blocking(move || crate::study_slides::ensure_pdf(&path).map(|_| ())).await.map_err(|e| e.to_string())?
}

/// Keeps the page text pdf.js took out of a book, for search.
#[tauri::command]
pub fn study_save_index(course: String, file: String, bytes: u64, pages: Vec<String>) -> Result<(), String> {
    let root = current_root()?;
    resolve(&root, &format!("{}/{}", course, file)).ok_or("No such book")?;
    save_text(&index_dir().ok_or("The study index isn't ready")?, &course, &file, &BookText { bytes, pages, version: INDEX_VERSION })
}

/// Pages of the library's books that match `query`, best first.
#[tauri::command]
pub fn study_search(manager: tauri::State<'_, crate::bridgelink::BridgeLinkManager>, query: String, course: Option<String>) -> Result<Vec<Hit>, String> {
    let (library, dir) = library_for_search()?;
    let notes = course_notes(&crate::bridgelink::notes::notes_list(manager)?);
    Ok(search(&library, &dir, &query, course.as_deref(), 30, &notes))
}

/// The notes kept in courses (`Study/<course>`), as search documents. Flashcard notes are left out.
pub fn course_notes(notes: &[crate::bridgelink::notes::Note]) -> Vec<NoteDoc> {
    notes
        .iter()
        .filter(|n| !n.deleted && !n.title.to_lowercase().contains("flashcards"))
        .filter_map(|n| {
            let course = n.folder.strip_prefix("Study/")?.split('/').next()?.to_string();
            let text = n.blocks.iter().filter(|b| !b.deleted).map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n");
            Some(NoteDoc { course, title: crate::bridgelink::notes::display_title(n), id: n.id.clone(), text })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn course_info_keeps_what_the_study_tab_adds() {
        let text = r#"{"code":"EE 201","title":"Digital Logic Design","canvasId":"7","canvasCode":"E E 201 Sec05","meetings":[{"days":[1,3],"start":"10:00","end":"11:15","room":"ECS 302"}],"grading":{"categories":[]}}"#;
        let info: CourseInfo = serde_json::from_str(text).unwrap();
        assert_eq!((info.code.as_str(), info.canvas_id.as_str()), ("EE 201", "7"));
        assert!(info.more.contains_key("meetings") && info.more.contains_key("grading"));
        let back: serde_json::Value = serde_json::to_value(&info).unwrap();
        assert_eq!(back["meetings"][0]["room"], "ECS 302");
        assert_eq!(back["canvasCode"], "E E 201 Sec05");
    }

    #[test]
    fn courses_and_books_are_listed_added_and_served_only_from_the_library() {
        let base = std::env::temp_dir().join(format!("bd-study-{}", uuid::Uuid::new_v4()));
        let root = root_for(&base.to_string_lossy());
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("Calculus_Early-Transcendentals.pdf"), b"%PDF-1.7 book").unwrap();
        fs::write(outside.join("notes.txt"), b"x").unwrap();
        fs::write(outside.join("secret.pdf"), b"not in the library").unwrap();

        let added = add_books(&root, "Math 221: Calc", &[outside.join("Calculus_Early-Transcendentals.pdf")]).unwrap();
        assert_eq!(added[0].title, "Calculus Early Transcendentals");
        assert!(add_books(&root, "Math 221: Calc", &[outside.join("notes.txt")]).is_err());
        // The same book again gets its own name.
        let again = add_books(&root, "Math 221: Calc", &[outside.join("Calculus_Early-Transcendentals.pdf")]).unwrap();
        assert_eq!(again[0].file, "Calculus_Early-Transcendentals (2).pdf");
        let library = read_library(&root).unwrap();
        assert_eq!(library.courses.len(), 1);
        assert_eq!(library.courses[0].name, "Math 221- Calc");
        assert_eq!(library.courses[0].books.len(), 2);

        assert!(resolve(&root, "/Math%20221-%20Calc/Calculus_Early-Transcendentals.pdf").is_some());
        assert!(resolve(&root, "/Math%20221-%20Calc/..%2F..%2Foutside%2Fsecret.pdf").is_none());
        assert!(resolve(&root, "/../outside/secret.pdf").is_none());
        assert!(resolve(&root, "/Math%20221-%20Calc/missing.pdf").is_none());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn lecture_transcripts_are_searched_a_minute_at_a_time() {
        let root = std::env::temp_dir().join(format!("bd-study-lectures-{}", uuid::Uuid::new_v4()));
        let course = root.join("EE 310");
        std::fs::create_dir_all(course.join("Lectures")).unwrap();
        std::fs::write(course.join("Lectures").join("Lecture 4.webm"), [0x1A, 0x45, 0xDF, 0xA3]).unwrap();
        crate::study_lectures::write_sidecar(&course, "Lecture 4.webm", &serde_json::json!({ "segments": [
            { "start": 0, "end": 5, "text": "Today, nodes." }, { "start": 30, "end": 35, "text": "Kirchhoff's current law says" },
            { "start": 75, "end": 80, "text": "Mesh analysis next." },
        ] })).unwrap();
        let library = Library { root: root.to_string_lossy().to_string(), courses: vec![Course { name: "EE 310".into(), books: vec![], archived: false, info: CourseInfo::default() }] };
        let hits = search(&library, &root.join("index"), "Kirchhoff current", None, 5, &[]);
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].kind, hits[0].t, hits[0].book.as_str(), hits[0].page), ("lecture", Some(0), "Lecture 4", 1));
        assert_eq!(search(&library, &root.join("index"), "mesh", None, 5, &[])[0].t, Some(75));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn pages_are_found_by_relevance_with_a_passage_around_the_words() {
        let dir = std::env::temp_dir().join(format!("bd-study-index-{}", uuid::Uuid::new_v4()));
        let book = |file: &str, title: &str| Book { file: file.into(), title: title.into(), kind: "pdf".into(), bytes: 10, indexed: true };
        let library = Library {
            root: String::new(),
            courses: vec![
                Course { name: "Math 221".into(), books: vec![book("calc.pdf", "Calculus")], archived: false, info: CourseInfo::default() },
                Course { name: "Biology".into(), books: vec![book("bio.pdf", "Campbell Biology")], archived: false, info: CourseInfo::default() },
            ],
        };
        let filler = "Some words about other things. ".repeat(20);
        save_text(&dir, "Math 221", "calc.pdf", &BookText { bytes: 10, pages: vec![
            format!("Limits. {filler}"),
            format!("{filler} The chain rule: the derivative of f(g(x)) is f'(g(x)) g'(x). Using the chain rule twice…"),
            format!("Integrals and the derivative are inverse. {filler}"),
        ], version: INDEX_VERSION }).unwrap();
        save_text(&dir, "Biology", "bio.pdf", &BookText { bytes: 10, pages: vec![format!("Mitochondria make ATP. {filler}")], version: INDEX_VERSION }).unwrap();

        let hits = search(&library, &dir, "What is the chain rule for a derivative?", None, 5, &[]);
        assert_eq!((hits[0].book.as_str(), hits[0].page), ("Calculus", 2));
        assert!(hits[0].snippet.starts_with('…') && hits[0].snippet.contains("chain rule"), "{}", hits[0].snippet);
        assert_eq!(hits.len(), 2, "page 3 mentions the derivative too");
        assert!(search(&library, &dir, "mitochondria", Some("math"), 5, &[]).is_empty());
        assert_eq!(search(&library, &dir, "Mitochondria", Some("bio"), 5, &[])[0].course, "Biology");
        assert!(search(&library, &dir, "the of and", None, 5, &[]).is_empty());
        // Course notes are searched too.
        let notes = [NoteDoc { course: "Biology".into(), title: "Cell notes".into(), id: "n1".into(), text: "Ribosomes build proteins.".into() }];
        let hit = &search(&library, &dir, "ribosomes", None, 5, &notes)[0];
        assert_eq!((hit.kind, hit.file.as_str(), hit.book.as_str()), ("note", "n1", "Cell notes"));
        // A new edition (different size) shows as not indexed; a reload after a change is seen.
        assert_eq!(load_text(&dir, "Math 221", "calc.pdf").unwrap().bytes, 10);
        std::thread::sleep(std::time::Duration::from_millis(20));
        save_text(&dir, "Math 221", "calc.pdf", &BookText { bytes: 11, pages: vec!["new".into()], version: INDEX_VERSION }).unwrap();
        assert_eq!(load_text(&dir, "Math 221", "calc.pdf").unwrap().bytes, 11);
        let course = find_course(&library, "math").unwrap();
        assert_eq!(find_book(course, "calcul").unwrap().file, "calc.pdf");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn indexes_from_before_text_recognition_are_read_again() {
        let old: BookText = serde_json::from_str(r#"{"bytes":10,"pages":[""]}"#).unwrap();
        assert!(old.version < INDEX_VERSION);
    }

    #[test]
    fn course_settings_change_one_at_a_time_and_conflict_copies_merge() {
        let dir = std::env::temp_dir().join(format!("bd-course-info-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let obj = |v: serde_json::Value| v.as_object().unwrap().clone();
        patch_info(&dir, obj(serde_json::json!({"code": "  EE 310 ", "meetings": [1]}))).unwrap();
        // Another computer's change to the grading arrives; a later change here to the code keeps it.
        let mut on_disk = read_info_map(&dir.join(INFO)).unwrap();
        on_disk.insert("grading".into(), serde_json::json!({"a": 1}));
        fs::write(dir.join(INFO), serde_json::to_vec(&on_disk).unwrap()).unwrap();
        patch_info(&dir, obj(serde_json::json!({"title": "Electronics", "meetings": null}))).unwrap();
        let info = read_info(&dir);
        assert_eq!((info.code.as_str(), info.title.as_str()), ("EE 310", "Electronics"));
        assert_eq!(info.more.get("grading"), Some(&serde_json::json!({"a": 1})));
        assert!(!info.more.contains_key("meetings"));
        assert!(patch_info(&dir, obj(serde_json::json!({"code": 5}))).is_err());
        // A Syncthing conflict copy: its new setting comes in, and for one both changed the newer wins.
        assert_eq!(merge_info(obj(serde_json::json!({"a": 1, "b": 1})), obj(serde_json::json!({"b": 2, "c": 3})), false), obj(serde_json::json!({"a": 1, "b": 1, "c": 3})));
        assert_eq!(merge_info(obj(serde_json::json!({"a": 1, "b": 1})), obj(serde_json::json!({"b": 2})), true), obj(serde_json::json!({"a": 1, "b": 2})));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn byte_ranges_are_read() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=950-5000", 1000), Some((950, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-1", 1000), None);
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-9", 1000), None);
        assert_eq!(parse_range("bytes=x-1", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        // A big ask is cut to 16 MB.
        assert_eq!(parse_range("bytes=0-", 100_000_000), Some((0, 16 * 1024 * 1024 - 1)));
    }

    #[test]
    fn a_semester_export_has_the_courses_being_taken_and_the_study_state() {
        let base = std::env::temp_dir().join(format!("bd-semester-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("Study");
        for d in ["EE 310/Lectures", "EE 310/.cache", "Old/x", ".state/problems"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        for (f, t) in [(".term.json", "{}"), (".state/problems/pc.json", "{}"), ("EE 310/.course.json", "{}"), ("EE 310/Book.pdf", "%PDF"), ("EE 310/Lectures/Oct 14.webm", "a"), ("EE 310/.cache/x", "no"), ("EE 310/n.json.partial", "no"), ("Old/x/a.pdf", "no"), ("Old/.archived", "")] {
            fs::write(root.join(f), t).unwrap();
        }
        let names: Vec<String> = semester_files(&root).iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();
        assert_eq!(names, [".state/problems/pc.json", ".term.json", "EE 310/.course.json", "EE 310/Book.pdf", "EE 310/Lectures/Oct 14.webm"]);
        let zip_path = base.join("semester.zip");
        assert_eq!(export_semester(&root, &zip_path).unwrap(), 5);
        let mut zip = zip::ZipArchive::new(fs::File::open(&zip_path).unwrap()).unwrap();
        assert!(zip.by_name("Study/EE 310/Book.pdf").is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn made_pdfs_are_saved_beside_the_books_without_replacing_any() {
        let dir = std::env::temp_dir().join(format!("bd-save-pdf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(save_pdf(&dir, "Homework 4", b"%PDF-1.7 x").unwrap(), "Homework 4.pdf");
        assert_eq!(save_pdf(&dir, "Homework 4.pdf", b"%PDF-1.7 y").unwrap(), "Homework 4 (2).pdf");
        assert_eq!(save_pdf(&dir, "../../x", b"%PDF-1.7").unwrap(), "-..-x.pdf");
        assert!(save_pdf(&dir, "Not", b"<html>").is_err());
        assert!(save_pdf(&dir, "  ", b"%PDF-").is_err());
        assert_eq!(fs::read(dir.join("Homework 4.pdf")).unwrap(), b"%PDF-1.7 x");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn downloads_go_only_where_chosen_as_pdfs() {
        let dir = std::env::temp_dir().join(format!("bd-download-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        write_download(&dir.join("Ch 3.pdf"), b"%PDF-1.7 x").unwrap();
        assert_eq!(fs::read(dir.join("Ch 3.pdf")).unwrap(), b"%PDF-1.7 x");
        assert!(write_download(&dir.join("x.exe"), b"%PDF-1.7").is_err());
        assert!(write_download(&dir.join("x.pdf"), b"MZ").is_err());
        assert!(write_download(Path::new("x.pdf"), b"%PDF-").is_err());
        assert!(write_download(&dir.join("missing/x.pdf"), b"%PDF-").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn card_pictures_are_saved_and_served_only_from_cards() {
        let root = std::env::temp_dir().join(format!("bd-cardpics-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let course = root.join("EE 310");
        fs::create_dir_all(&course).unwrap();
        let png = b"\x89PNG\r\n\x1a\nrest";
        let file = save_card_picture(&course, "../../circuit.svg", png).unwrap();
        assert_eq!(file, "circuit.png");
        assert!(save_card_picture(&course, "x.png", b"<svg/>").is_err());
        assert!(resolve(&root, &format!("/EE%20310/Cards/{file}")).is_some());
        fs::write(course.join("Cards").join("notes.pdf"), b"%PDF-").unwrap();
        assert!(resolve(&root, "/EE%20310/Cards/notes.pdf").is_none());
        assert!(resolve(&root, "/EE%20310/Other/circuit.png").is_none());
        assert!(resolve(&root, "/EE%20310/Cards/..%2F..%2Fx.png").is_none());
        std::fs::create_dir_all(course.join("Lectures")).unwrap();
        fs::write(course.join("Lectures").join("Lecture 1.webm"), [0x1A, 0x45, 0xDF, 0xA3]).unwrap();
        assert!(resolve(&root, "/EE%20310/Lectures/Lecture%201.webm").is_some());
        assert!(resolve(&root, "/EE%20310/Lectures/circuit.png").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn card_lists_are_saved_as_csv_beside_the_books() {
        let dir = std::env::temp_dir().join(format!("bd-csv-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(save_csv(&dir, "EE 310 flashcards.csv", "kind,front\r\n").unwrap(), "EE 310 flashcards.csv");
        assert_eq!(save_csv(&dir, "EE 310 flashcards", "x").unwrap(), "EE 310 flashcards (2).csv");
        assert_eq!(fs::read_to_string(dir.join("EE 310 flashcards.csv")).unwrap(), "kind,front\r\n");
        let _ = fs::remove_dir_all(&dir);
    }
}