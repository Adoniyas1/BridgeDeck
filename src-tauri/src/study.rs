//! The Study library: one folder per course with its textbooks, inside the folder the paired
//! computers already sync (`BridgeDeck Shared/Study/<Course>/`), so a book added on one computer
//! arrives on the other. Course notes, chapter checklists and highlights are ordinary notes in the
//! `Study/<Course>` folder; exams are calendar events.
//!
//! Books are read through the `bdbook` URI scheme, which serves files from the library and nothing
//! else (paths are checked after resolving links and `..`).

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const SCHEME: &str = "bdbook";
const BOOK_EXTENSIONS: &[&str] = &["pdf", "epub"];

/// The library folder, remembered for the `bdbook` scheme.
static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    /// File name inside the course folder.
    pub file: String,
    pub title: String,
    /// "pdf" or "epub".
    pub kind: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Course {
    pub name: String,
    pub books: Vec<Book>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub root: String,
    pub courses: Vec<Course>,
}

fn default_shared() -> PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join("BridgeDeck Shared")
}

/// `<shared folder>/Study`.
fn root_for(shared: &str) -> PathBuf {
    let shared = if shared.trim().is_empty() { default_shared() } else { PathBuf::from(shared.trim()) };
    shared.join("Study")
}

/// A course or book name made safe as a single folder or file name.
fn clean_name(name: &str) -> Result<String, String> {
    let cleaned: String = name.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '-' } else { c }).collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().chars().take(100).collect::<String>();
    if cleaned.is_empty() { Err("Give it a name".into()) } else { Ok(cleaned) }
}

fn title_of(file: &str) -> String {
    Path::new(file).file_stem().map(|s| s.to_string_lossy().replace(['_', '-'], " ")).unwrap_or_default().trim().to_string()
}

fn book_kind(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    BOOK_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
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
                Some(Book { title: title_of(&file), file, kind, bytes: f.metadata().map(|m| m.len()).unwrap_or(0) })
            })
            .collect();
        books.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        courses.push(Course { name, books });
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
        let kind = book_kind(path).ok_or_else(|| format!("{} isn't a PDF or EPUB", path.display()))?;
        let original = path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("No file name")?;
        let file = free_name(&dir, &clean_name(&original)?);
        let bytes = fs::copy(path, dir.join(&file)).map_err(|e| format!("Couldn't copy {original}: {e}"))?;
        added.push(Book { title: title_of(&file), file, kind, bytes });
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
    let Some(path) = resolve(&root, request.uri().path()) else { return fail(StatusCode::NOT_FOUND) };
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

/// Removes a book from the course (and so from the other computer too).
#[tauri::command]
pub fn study_remove_book(course: String, file: String) -> Result<(), String> {
    let root = current_root()?;
    let path = resolve(&root, &format!("{}/{}", course, file)).ok_or("No such book")?;
    fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
