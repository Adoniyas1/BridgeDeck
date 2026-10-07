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
/// Slides kept with a course and opened in the computer's own app (PDF slides are books).
const SLIDE_EXTENSIONS: &[&str] = &["pptx", "ppt", "key", "odp"];
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
    fs::read(dir.join(INFO)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
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
    (BOOK_EXTENSIONS.contains(&ext.as_str()) || SLIDE_EXTENSIONS.contains(&ext.as_str())).then_some(ext)
}

pub fn init(app: &tauri::AppHandle) {
    if let (Ok(dir), Ok(mut stored)) = (app.path().app_data_dir(), INDEX_DIR.lock()) {
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

fn current_root() -> Result<PathBuf, String> {
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
        let kind = book_kind(path).ok_or_else(|| format!("{} isn't a PDF, EPUB or presentation", path.display()))?;
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
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('\\')) {
        return None;
    }
    let candidate = root.join(parts[0]).join(parts[1]);
    let real = candidate.canonicalize().ok()?;
    let real_root = root.canonicalize().ok()?;
    (real.starts_with(&real_root) && real.is_file() && book_kind(&real).is_some()).then_some(real)
}

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

/// Serves a book to the reader: the whole file, or the byte range asked for.
pub fn serve(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let fail = |status: StatusCode| Response::builder().status(status).body(Vec::new()).unwrap();
    let Ok(root) = current_root() else { return fail(StatusCode::NOT_FOUND) };
    let Some(path) = resolve(&root, request.uri().path()).filter(|p| book_kind(p).is_some_and(|k| BOOK_EXTENSIONS.contains(&k.as_str()))) else { return fail(StatusCode::NOT_FOUND) };
    let Ok(data) = fs::read(&path) else { return fail(StatusCode::NOT_FOUND) };
    let mime = if book_kind(&path).as_deref() == Some("epub") { "application/epub+zip" } else { "application/pdf" };
    let total = data.len();
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("bytes=")).and_then(|v| v.split_once('-')).and_then(|(a, b)| {
        let start: usize = a.parse().ok()?;
        let end: usize = if b.is_empty() { total.checked_sub(1)? } else { b.parse::<usize>().ok()?.min(total.checked_sub(1)?) };
        (start <= end).then_some((start, end))
    });
    let builder = Response::builder().header(header::CONTENT_TYPE, mime).header(header::ACCEPT_RANGES, "bytes").header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    match range {
        Some((start, end)) => builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
            .body(data[start..=end].to_vec())
            .unwrap(),
        None => builder.status(StatusCode::OK).body(data).unwrap(),
    }
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

/// The pages that best answer `query`, best first (BM25 over every page of the books in scope).
pub fn search(library: &Library, dir: &Path, query: &str, course: Option<&str>, limit: usize) -> Vec<Hit> {
    let terms: HashSet<String> = words(query).into_iter().collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let wanted = course.map(str::to_lowercase).filter(|c| !c.trim().is_empty());
    let mut pages: Vec<(&Course, &Book, usize, Arc<BookText>)> = Vec::new();
    for c in &library.courses {
        if wanted.as_ref().is_some_and(|w| !c.name.to_lowercase().contains(w.as_str())) {
            continue;
        }
        for b in &c.books {
            if let Some(text) = load_text(dir, &c.name, &b.file) {
                for i in 0..text.pages.len() {
                    pages.push((c, b, i, text.clone()));
                }
            }
        }
    }
    let counted: Vec<HashMap<String, usize>> = pages
        .iter()
        .map(|(_, _, i, text)| {
            let mut counts = HashMap::new();
            let all = words(&text.pages[*i]);
            counts.insert(String::new(), all.len());
            for w in all.into_iter().filter(|w| terms.contains(w)) {
                *counts.entry(w).or_insert(0) += 1;
            }
            counts
        })
        .collect();
    let n = pages.len() as f64;
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
            let (c, b, i, text) = &pages[index];
            Hit { course: c.name.clone(), book: b.title.clone(), file: b.file.clone(), page: i + 1, snippet: snippet(&text.pages[*i], &terms, 360), score: (score * 100.0).round() / 100.0 }
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

/// Sets a course's code, title and Canvas course.
#[tauri::command]
pub fn study_set_course_info(name: String, info: CourseInfo) -> Result<(), String> {
    let short = |s: &str| s.trim().chars().take(120).collect::<String>();
    let info = CourseInfo { code: short(&info.code), title: short(&info.title), canvas_id: short(&info.canvas_id), canvas_code: short(&info.canvas_code), more: info.more };
    let bytes = serde_json::to_vec_pretty(&info).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_PLAN {
        return Err("Too much to keep for one course".into());
    }
    let dir = course_dir(&current_root()?, &name)?;
    fs::write(dir.join(INFO), bytes).map_err(|e| e.to_string())
}

/// Study-wide state kept beside the courses (synced): the semester's dates, homework progress.
fn state_file(key: &str) -> Result<&'static str, String> {
    match key {
        "term" => Ok(".term.json"),
        "problems" => Ok(".problems.json"),
        "grades" => Ok(".grades.json"),
        _ => Err("Unknown study state".into()),
    }
}

#[tauri::command]
pub fn study_state_read(key: String) -> Result<String, String> {
    match fs::read_to_string(current_root()?.join(state_file(&key)?)) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn study_state_write(key: String, text: String) -> Result<(), String> {
    let file = state_file(&key)?;
    if text.len() > MAX_PLAN || serde_json::from_str::<serde_json::Value>(&text).is_err() {
        return Err("Not study state".into());
    }
    fs::write(current_root()?.join(file), text).map_err(|e| e.to_string())
}

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
    Ok(())
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
pub fn study_search(query: String, course: Option<String>) -> Result<Vec<Hit>, String> {
    let (library, dir) = library_for_search()?;
    Ok(search(&library, &dir, &query, course.as_deref(), 30))
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

        let hits = search(&library, &dir, "What is the chain rule for a derivative?", None, 5);
        assert_eq!((hits[0].book.as_str(), hits[0].page), ("Calculus", 2));
        assert!(hits[0].snippet.starts_with('…') && hits[0].snippet.contains("chain rule"), "{}", hits[0].snippet);
        assert_eq!(hits.len(), 2, "page 3 mentions the derivative too");
        assert!(search(&library, &dir, "mitochondria", Some("math"), 5).is_empty());
        assert_eq!(search(&library, &dir, "Mitochondria", Some("bio"), 5)[0].course, "Biology");
        assert!(search(&library, &dir, "the of and", None, 5).is_empty());
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
}
