//! The Manga tab's library: one folder per series in the folder the paired computers sync
//! (`BridgeDeck Shared/Manga/<Series>/`), each chapter a `.cbz`/`.zip` file or a folder of images.
//! A series' details (title, description, genres, where it's from) are in `series.json`, reading
//! progress and bookmarks in `.progress.json`, so both computers share them.
//!
//! Pages are served to the reader by the `bdmanga` URI scheme, from the library only (paths are
//! checked after resolving links and `..`). Series details can be looked up on AniList, and the
//! free Pepper&Carrot webcomic (CC BY 4.0) can be added from the Internet Archive.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const SCHEME: &str = "bdmanga";
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"];
const ARCHIVE_EXTENSIONS: &[&str] = &["cbz", "zip"];
const META_FILE: &str = "series.json";
const PROGRESS_FILE: &str = ".progress.json";
const MAX_PAGE: u64 = 64 * 1024 * 1024;

static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    /// File or folder name inside the series folder.
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    /// Folder name.
    pub name: String,
    pub chapters: Vec<Chapter>,
    /// `series.json`: title, description, genres, status, author, anilistId, attribution…
    pub meta: Value,
    /// `.progress.json`: { chapters: { id: { page, pages, done, at } }, last, bookmarks: { id: [page] } }
    pub progress: Value,
    pub has_cover: bool,
    pub modified: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub root: String,
    pub series: Vec<Series>,
}

fn ext(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn is_image(name: &str) -> bool {
    IMAGE_EXTENSIONS.contains(&ext(Path::new(name)).as_str())
}

/// "Chapter 2" before "Chapter 10".
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |s: &str| -> Vec<(u8, u64, String)> {
        let mut out = Vec::new();
        let mut digits = String::new();
        let mut text = String::new();
        for c in s.to_lowercase().chars() {
            if c.is_ascii_digit() {
                if !text.is_empty() {
                    out.push((1, 0, std::mem::take(&mut text)));
                }
                digits.push(c);
            } else {
                if !digits.is_empty() {
                    out.push((0, digits.parse().unwrap_or(u64::MAX), String::new()));
                    digits.clear();
                }
                text.push(c);
            }
        }
        if !digits.is_empty() {
            out.push((0, digits.parse().unwrap_or(u64::MAX), String::new()));
        }
        if !text.is_empty() {
            out.push((1, 0, text));
        }
        out
    };
    key(a).cmp(&key(b)).then_with(|| a.cmp(b))
}

fn chapter_title(id: &str) -> String {
    let stem = Path::new(id).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| id.to_string());
    let path = Path::new(id);
    let base = if path.extension().is_some_and(|e| ARCHIVE_EXTENSIONS.contains(&e.to_string_lossy().to_ascii_lowercase().as_str())) { stem } else { id.to_string() };
    base.replace(['_'], " ").trim().to_string()
}

fn default_shared() -> PathBuf {
    crate::study::default_shared()
}

pub fn root_for(shared: &str) -> PathBuf {
    let shared = if shared.trim().is_empty() { default_shared() } else { PathBuf::from(shared.trim()) };
    shared.join("Manga")
}

fn current_root() -> Result<PathBuf, String> {
    ROOT.lock().ok().and_then(|r| r.clone()).ok_or_else(|| "Open the Manga tab first".into())
}

fn read_json(path: &Path) -> Value {
    fs::read(path).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_else(|| json!({}))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let partial = path.with_extension("part");
    fs::write(&partial, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&partial, path).map_err(|e| e.to_string())
}

fn chapters_in(dir: &Path) -> Vec<Chapter> {
    let mut list: Vec<Chapter> = fs::read_dir(dir)
        .map(|d| d.filter_map(Result::ok).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let kind = e.file_type().ok()?;
            let chapter = (kind.is_file() && ARCHIVE_EXTENSIONS.contains(&ext(&e.path()).as_str()))
                || (kind.is_dir() && fs::read_dir(e.path()).ok()?.filter_map(Result::ok).any(|f| is_image(&f.file_name().to_string_lossy())));
            chapter.then(|| Chapter { title: chapter_title(&name), id: name })
        })
        .collect();
    list.sort_by(|a, b| natural_cmp(&a.id, &b.id));
    list
}

fn cover_file(dir: &Path) -> Option<PathBuf> {
    ["cover.jpg", "cover.jpeg", "cover.png", "cover.webp"].iter().map(|n| dir.join(n)).find(|p| p.is_file())
}

pub fn read_library(root: &Path) -> Result<Library, String> {
    fs::create_dir_all(root).map_err(|e| format!("Can't use the Manga folder {}: {e}", root.display()))?;
    let mut series: Vec<Series> = fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let dir = e.path();
            let modified = fs::metadata(&dir).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            Some(Series { chapters: chapters_in(&dir), meta: read_json(&dir.join(META_FILE)), progress: read_json(&dir.join(PROGRESS_FILE)), has_cover: cover_file(&dir).is_some(), modified, name })
        })
        .collect();
    series.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    Ok(Library { root: root.to_string_lossy().to_string(), series })
}

/// A plain name inside its parent: no separators, no `..`.
fn plain(name: &str) -> Result<&str, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) || name.contains('\0') {
        return Err("Invalid name".into());
    }
    Ok(name)
}

/// The series folder (inside the library after resolving links).
fn series_dir(root: &Path, series: &str) -> Result<PathBuf, String> {
    let dir = root.join(plain(series)?);
    let real = dir.canonicalize().map_err(|_| "No such series".to_string())?;
    let real_root = root.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&real_root) || !real.is_dir() {
        return Err("No such series".into());
    }
    Ok(real)
}

/// The image names of a chapter, in reading order.
pub fn pages(root: &Path, series: &str, chapter: &str) -> Result<Vec<String>, String> {
    let dir = series_dir(root, series)?;
    let path = dir.join(plain(chapter)?);
    let real = path.canonicalize().map_err(|_| "No such chapter".to_string())?;
    if !real.starts_with(&dir) {
        return Err("No such chapter".into());
    }
    let mut names: Vec<String> = if real.is_dir() {
        fs::read_dir(&real).map_err(|e| e.to_string())?.filter_map(Result::ok).filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false)).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| is_image(n) && !n.starts_with('.')).collect()
    } else {
        let mut archive = zip::ZipArchive::new(fs::File::open(&real).map_err(|e| e.to_string())?).map_err(|e| format!("Not a readable .cbz/.zip: {e}"))?;
        (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().filter(|f| f.is_file()).map(|f| f.name().to_string()))
            .filter(|n| is_image(n) && !n.starts_with("__MACOSX/") && !n.rsplit('/').next().unwrap_or("").starts_with('.'))
            .collect()
    };
    names.sort_by(|a, b| natural_cmp(a, b));
    Ok(names)
}

fn mime(name: &str) -> &'static str {
    match ext(Path::new(name)).as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

/// One page's bytes and type.
pub fn page(root: &Path, series: &str, chapter: &str, index: usize) -> Result<(Vec<u8>, &'static str), String> {
    let names = pages(root, series, chapter)?;
    let name = names.get(index).ok_or("No such page")?;
    let dir = series_dir(root, series)?;
    let path = dir.join(chapter);
    let mut data = Vec::new();
    if path.is_dir() {
        let file = path.join(name);
        if fs::metadata(&file).map(|m| m.len()).unwrap_or(0) > MAX_PAGE {
            return Err("Page too large".into());
        }
        data = fs::read(file).map_err(|e| e.to_string())?;
    } else {
        let mut archive = zip::ZipArchive::new(fs::File::open(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut entry = archive.by_name(name).map_err(|e| e.to_string())?;
        if entry.size() > MAX_PAGE {
            return Err("Page too large".into());
        }
        entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
    }
    Ok((data, mime(name)))
}

fn cover(root: &Path, series: &str) -> Result<(Vec<u8>, &'static str), String> {
    let dir = series_dir(root, series)?;
    if let Some(file) = cover_file(&dir) {
        let name = file.to_string_lossy().to_string();
        return Ok((fs::read(&file).map_err(|e| e.to_string())?, mime(&name)));
    }
    let first = chapters_in(&dir).into_iter().next().ok_or("No cover")?;
    page(root, series, &first.id, 0)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            out.push(u8::from_str_radix(std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `bdmanga://localhost/<series>/<chapter>/<page>` or `/<series>/.cover`.
pub fn serve(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let fail = |status: StatusCode| Response::builder().status(status).body(Vec::new()).unwrap();
    let Ok(root) = current_root() else { return fail(StatusCode::NOT_FOUND) };
    // The window builds these with convertFileSrc, which escapes the slashes too: decode, then split.
    let Some(path) = percent_decode(request.uri().path().trim_start_matches('/')) else { return fail(StatusCode::NOT_FOUND) };
    let parts: Vec<String> = path.split('/').map(str::to_string).collect();
    let result = match parts.as_slice() {
        [series, cover_name] if cover_name == ".cover" => cover(&root, series),
        [series, chapter, index] => index.parse::<usize>().map_err(|e| e.to_string()).and_then(|i| page(&root, series, chapter, i)),
        _ => Err("Not found".into()),
    };
    match result {
        Ok((data, mime)) => Response::builder()
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "max-age=3600")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(data)
            .unwrap(),
        Err(_) => fail(StatusCode::NOT_FOUND),
    }
}

/// Adds chapters to a series: `.cbz`/`.zip` files are copied as they are, folders of images
/// become chapters, and loose images together become one new chapter.
pub fn add(root: &Path, series: &str, paths: &[PathBuf]) -> Result<usize, String> {
    let dir = root.join(crate::study::clean_name(series)?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let free = |name: &str| -> PathBuf {
        let mut target = dir.join(name);
        let mut n = 2;
        while target.exists() {
            let p = Path::new(name);
            let (stem, ext) = (p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default());
            target = dir.join(format!("{stem} ({n}){ext}"));
            n += 1;
        }
        target
    };
    let mut added = 0;
    let mut loose = Vec::new();
    for path in paths {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("No file name")?;
        if path.is_dir() {
            let images: Vec<PathBuf> = fs::read_dir(path).map_err(|e| e.to_string())?.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_file() && is_image(&p.to_string_lossy())).collect();
            if images.is_empty() {
                continue;
            }
            let target = free(&crate::study::clean_name(&name)?);
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            for image in images {
                fs::copy(&image, target.join(image.file_name().unwrap_or_default())).map_err(|e| e.to_string())?;
            }
            added += 1;
        } else if ARCHIVE_EXTENSIONS.contains(&ext(path).as_str()) {
            zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?).map_err(|_| format!("{name} isn't a readable .cbz/.zip"))?;
            fs::copy(path, free(&crate::study::clean_name(&name)?)).map_err(|e| e.to_string())?;
            added += 1;
        } else if is_image(&name) {
            loose.push(path.clone());
        }
    }
    if !loose.is_empty() {
        let target = free(&format!("Chapter {}", chapters_in(&dir).len() + 1));
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        for image in &loose {
            fs::copy(image, target.join(image.file_name().unwrap_or_default())).map_err(|e| e.to_string())?;
        }
        added += 1;
    }
    Ok(added)
}

/// Records how far a chapter has been read (and whether it's finished); keeps the furthest page.
pub fn record_progress(root: &Path, series: &str, chapter: &str, page_index: u32, pages_total: u32, now: u64) -> Result<Value, String> {
    let dir = series_dir(root, series)?;
    plain(chapter)?;
    let file = dir.join(PROGRESS_FILE);
    let mut progress = read_json(&file);
    let map = progress.as_object_mut().ok_or("Damaged progress file")?;
    let chapters = map.entry("chapters").or_insert_with(|| json!({}));
    let done = pages_total > 0 && page_index + 1 >= pages_total;
    let previous_done = chapters[chapter]["done"].as_bool().unwrap_or(false);
    chapters[chapter] = json!({ "page": page_index, "pages": pages_total, "done": done || previous_done, "at": now });
    map.insert("last".into(), json!(chapter));
    map.insert("at".into(), json!(now));
    write_json(&file, &progress)?;
    Ok(progress)
}

pub fn toggle_bookmark(root: &Path, series: &str, chapter: &str, page_index: u32) -> Result<Value, String> {
    let dir = series_dir(root, series)?;
    plain(chapter)?;
    let file = dir.join(PROGRESS_FILE);
    let mut progress = read_json(&file);
    let map = progress.as_object_mut().ok_or("Damaged progress file")?;
    let bookmarks = map.entry("bookmarks").or_insert_with(|| json!({}));
    let list = bookmarks.as_object_mut().ok_or("Damaged bookmarks")?.entry(chapter.to_string()).or_insert_with(|| json!([]));
    let pages = list.as_array_mut().ok_or("Damaged bookmarks")?;
    if let Some(i) = pages.iter().position(|p| p.as_u64() == Some(page_index as u64)) {
        pages.remove(i);
    } else {
        pages.push(json!(page_index));
    }
    write_json(&file, &progress)?;
    Ok(progress)
}

/// Merges `meta` into `series.json` (only the known fields).
pub fn save_meta(root: &Path, series: &str, meta: &Value) -> Result<Value, String> {
    let dir = series_dir(root, series)?;
    let file = dir.join(META_FILE);
    let mut current = read_json(&file);
    let map = current.as_object_mut().ok_or("Damaged series.json")?;
    for key in ["title", "description", "genres", "status", "author", "anilistId", "year", "attribution", "url", "format"] {
        if let Some(value) = meta.get(key) {
            map.insert(key.into(), value.clone());
        }
    }
    write_json(&file, &current)?;
    Ok(current)
}

// ---- AniList (series details), covers, Pepper&Carrot ----

const ANILIST_QUERY: &str = "query ($q: String) { Page(perPage: 12) { media(search: $q, type: MANGA) { id siteUrl format status startDate { year } title { romaji english native } description(asHtml: false) genres coverImage { large extraLarge } staff(perPage: 3) { edges { role node { name { full } } } } } } }";

/// AniList's results for a title, simplified.
pub fn anilist_results(answer: &Value) -> Vec<Value> {
    answer["data"]["Page"]["media"].as_array().cloned().unwrap_or_default().iter().map(|m| {
        let title = m["title"]["english"].as_str().or(m["title"]["romaji"].as_str()).unwrap_or("").to_string();
        let author = m["staff"]["edges"].as_array().and_then(|e| e.iter().find(|s| s["role"].as_str().is_some_and(|r| r.contains("Story")))).or_else(|| m["staff"]["edges"].get(0)).and_then(|s| s["node"]["name"]["full"].as_str()).unwrap_or("").to_string();
        let description = m["description"].as_str().unwrap_or("").replace("<br>", "\n").replace('\r', "");
        let description: String = description.split('<').enumerate().map(|(i, part)| if i == 0 { part } else { part.split_once('>').map(|(_, rest)| rest).unwrap_or("") }).collect();
        json!({
            "anilistId": m["id"], "title": title, "nativeTitle": m["title"]["native"], "description": description.trim(), "genres": m["genres"],
            "status": m["status"].as_str().map(|s| s.replace('_', " ").to_lowercase()), "author": author, "year": m["startDate"]["year"],
            "format": m["format"], "url": m["siteUrl"], "cover": m["coverImage"]["extraLarge"].as_str().or(m["coverImage"]["large"].as_str()),
        })
    }).collect()
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(60)).user_agent("BridgeDeck manga reader").build().map_err(|e| e.to_string())
}

/// Only AniList's image servers are fetched for covers.
pub fn cover_url_allowed(url: &str) -> bool {
    reqwest::Url::parse(url).ok().is_some_and(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| h == "s4.anilist.co" || h.ends_with(".anilist.co") || h == "img.anili.st"))
}

pub const PEPPERCARROT: &str = "Pepper&Carrot";
pub const PEPPERCARROT_EPISODES: u32 = 23;

// ---- Commands ----

#[tauri::command]
pub fn manga_library(shared: String) -> Result<Library, String> {
    let root = root_for(&shared);
    if let Ok(mut stored) = ROOT.lock() {
        *stored = Some(root.clone());
    }
    read_library(&root)
}

#[tauri::command]
pub fn manga_pages(series: String, chapter: String) -> Result<usize, String> {
    Ok(pages(&current_root()?, &series, &chapter)?.len())
}

#[tauri::command]
pub fn manga_add(series: String, paths: Vec<String>) -> Result<usize, String> {
    add(&current_root()?, &series, &paths.into_iter().map(PathBuf::from).collect::<Vec<_>>())
}

#[tauri::command]
pub fn manga_progress(series: String, chapter: String, page: u32, pages: u32) -> Result<Value, String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    record_progress(&current_root()?, &series, &chapter, page, pages, now)
}

#[tauri::command]
pub fn manga_bookmark(series: String, chapter: String, page: u32) -> Result<Value, String> {
    toggle_bookmark(&current_root()?, &series, &chapter, page)
}

#[tauri::command]
pub fn manga_save_meta(series: String, meta: Value) -> Result<Value, String> {
    save_meta(&current_root()?, &series, &meta)
}

/// Removes a chapter (or with no chapter, the whole series); it's removed from the other computer too.
#[tauri::command]
pub fn manga_remove(series: String, chapter: Option<String>) -> Result<(), String> {
    let dir = series_dir(&current_root()?, &series)?;
    match chapter {
        Some(chapter) => {
            let path = dir.join(plain(&chapter)?);
            if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }.map_err(|e| e.to_string())
        }
        None => fs::remove_dir_all(dir).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn manga_search_details(query: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let answer: Value = http()?.post("https://graphql.anilist.co").json(&json!({ "query": ANILIST_QUERY, "variables": { "q": query } })).send().map_err(|e| format!("Couldn't reach AniList: {e}"))?.json().map_err(|e| e.to_string())?;
        Ok(anilist_results(&answer))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves details picked from AniList, with its cover as `cover.jpg`.
#[tauri::command]
pub async fn manga_apply_details(series: String, details: Value) -> Result<Value, String> {
    let root = current_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(url) = details["cover"].as_str().filter(|u| cover_url_allowed(u)) {
            let bytes = http()?.get(url).send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes()).map_err(|e| format!("Couldn't get the cover: {e}"))?;
            if bytes.len() < 10 * 1024 * 1024 {
                fs::write(series_dir(&root, &series)?.join("cover.jpg"), &bytes).map_err(|e| e.to_string())?;
            }
        }
        save_meta(&root, &series, &details)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Adds Pepper&Carrot episodes (David Revoy, CC BY 4.0) from the Internet Archive's official CBZs.
#[tauri::command]
pub async fn manga_add_peppercarrot(episodes: Vec<u32>) -> Result<usize, String> {
    let root = current_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = root.join(PEPPERCARROT);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut meta: Map<String, Value> = Map::new();
        meta.insert("title".into(), json!("Pepper&Carrot"));
        meta.insert("author".into(), json!("David Revoy"));
        meta.insert("description".into(), json!("A young witch and her cat in the magical world of Hereva. A free webcomic, funded by its readers."));
        meta.insert("attribution".into(), json!({ "author": "David Revoy", "url": "https://www.peppercarrot.com", "license": "CC BY 4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/", "source": "https://archive.org/details/peppercarrot-en" }));
        save_meta(&root, PEPPERCARROT, &Value::Object(meta))?;
        let client = http()?;
        let mut added = 0;
        for n in episodes.into_iter().filter(|n| (1..=PEPPERCARROT_EPISODES).contains(n)) {
            let name = format!("peppercarrot_episode{n:02}.cbz");
            let target = dir.join(format!("Episode {n:02}.cbz"));
            if target.exists() {
                continue;
            }
            let bytes = client.get(format!("https://archive.org/download/peppercarrot-en/{name}")).send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes()).map_err(|e| format!("Couldn't get episode {n}: {e}"))?;
            zip::ZipArchive::new(std::io::Cursor::new(&bytes[..])).map_err(|_| format!("Episode {n} didn't arrive whole"))?;
            fs::write(&target, &bytes).map_err(|e| e.to_string())?;
            added += 1;
        }
        Ok(added)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn cbz(path: &Path, names: &[&str]) {
        let mut writer = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for name in names {
            writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(format!("image {name}").as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn a_library_of_cbz_files_and_image_folders_reads_in_order_and_stays_inside() {
        let base = std::env::temp_dir().join(format!("bd-manga-{}", uuid::Uuid::new_v4()));
        let root = root_for(&base.to_string_lossy());
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        cbz(&outside.join("Vol 1 Ch 10.cbz"), &["10.jpg", "2.jpg", "1.jpg", "__MACOSX/._1.jpg", "notes.txt", "sub/3.png"]);
        cbz(&outside.join("Vol 1 Ch 2.cbz"), &["a.webp"]);
        fs::create_dir_all(outside.join("Extra")).unwrap();
        fs::write(outside.join("Extra/p1.png"), "x").unwrap();
        fs::write(outside.join("loose1.jpg"), "a").unwrap();
        fs::write(outside.join("loose2.jpg"), "b").unwrap();
        fs::write(outside.join("broken.cbz"), "not a zip").unwrap();

        assert!(add(&root, "Frieren", &[outside.join("broken.cbz")]).unwrap_err().contains("isn't a readable"));
        let added = add(&root, "Frieren", &[outside.join("Vol 1 Ch 10.cbz"), outside.join("Vol 1 Ch 2.cbz"), outside.join("Extra"), outside.join("loose1.jpg"), outside.join("loose2.jpg")]).unwrap();
        assert_eq!(added, 4);
        let library = read_library(&root).unwrap();
        let series = &library.series[0];
        assert_eq!(series.chapters.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), vec!["Chapter 4", "Extra", "Vol 1 Ch 2", "Vol 1 Ch 10"]);
        assert_eq!(pages(&root, "Frieren", "Vol 1 Ch 10.cbz").unwrap(), vec!["1.jpg", "2.jpg", "10.jpg", "sub/3.png"], "images only, in natural order");
        assert_eq!(page(&root, "Frieren", "Vol 1 Ch 10.cbz", 2).unwrap(), (b"image 10.jpg".to_vec(), "image/jpeg"));
        assert_eq!(page(&root, "Frieren", "Extra", 0).unwrap().1, "image/png");
        assert_eq!(cover(&root, "Frieren").unwrap().0, b"a", "the first chapter's first page");
        assert!(pages(&root, "Frieren", "../../outside/Vol 1 Ch 2.cbz").is_err());
        assert!(series_dir(&root, "..").is_err());
        assert!(page(&root, "Frieren", "Extra", 9).is_err());

        // Progress keeps the chapter done once finished; bookmarks toggle.
        let p = record_progress(&root, "Frieren", "Vol 1 Ch 2.cbz", 0, 1, 5).unwrap();
        assert_eq!(p["chapters"]["Vol 1 Ch 2.cbz"]["done"], true);
        let p = record_progress(&root, "Frieren", "Vol 1 Ch 2.cbz", 0, 3, 6).unwrap();
        assert_eq!((p["chapters"]["Vol 1 Ch 2.cbz"]["done"].as_bool(), p["last"].as_str()), (Some(true), Some("Vol 1 Ch 2.cbz")));
        toggle_bookmark(&root, "Frieren", "Extra", 0).unwrap();
        assert_eq!(toggle_bookmark(&root, "Frieren", "Extra", 3).unwrap()["bookmarks"]["Extra"], json!([0, 3]));
        assert_eq!(toggle_bookmark(&root, "Frieren", "Extra", 0).unwrap()["bookmarks"]["Extra"], json!([3]));
        save_meta(&root, "Frieren", &json!({ "title": "Frieren: Beyond Journey's End", "evil": "x" })).unwrap();
        let library = read_library(&root).unwrap();
        assert_eq!(library.series[0].meta, json!({ "title": "Frieren: Beyond Journey's End" }));
        assert_eq!(library.series[0].progress["bookmarks"]["Extra"], json!([3]));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn anilist_answers_are_simplified_and_only_its_covers_are_fetched() {
        let answer = json!({ "data": { "Page": { "media": [{ "id": 118586, "siteUrl": "https://anilist.co/manga/118586", "format": "MANGA", "status": "RELEASING", "startDate": { "year": 2020 },
            "title": { "romaji": "Sousou no Frieren", "english": "Frieren: Beyond Journey's End", "native": "葬送のフリーレン" }, "description": "The <i>adventure</i> is over.<br><br>But life goes on.",
            "genres": ["Adventure", "Fantasy"], "coverImage": { "large": "https://s4.anilist.co/file/a.jpg", "extraLarge": "https://s4.anilist.co/file/b.jpg" },
            "staff": { "edges": [{ "role": "Art", "node": { "name": { "full": "Tsukasa Abe" } } }, { "role": "Story", "node": { "name": { "full": "Kanehito Yamada" } } }] } }] } } });
        let results = anilist_results(&answer);
        assert_eq!(results[0]["title"], "Frieren: Beyond Journey's End");
        assert_eq!(results[0]["author"], "Kanehito Yamada");
        assert_eq!(results[0]["status"], "releasing");
        assert_eq!(results[0]["description"], "The adventure is over.\n\nBut life goes on.");
        assert!(cover_url_allowed("https://s4.anilist.co/file/b.jpg"));
        assert!(!cover_url_allowed("http://s4.anilist.co/file/b.jpg") && !cover_url_allowed("https://evil.example/x.jpg") && !cover_url_allowed("https://anilist.co.evil.example/x.jpg"));
        assert_eq!(natural_cmp("Chapter 2", "Chapter 10"), std::cmp::Ordering::Less);
    }
}
