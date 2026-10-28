//! SolidCraft (github.com/bherbruck/solidcraft, MIT or Apache-2.0): open-source parametric CAD laid
//! out like Fusion 360 (Design workspace, ribbon, browser tree, view cube, history timeline). Its
//! browser build, a static site of about 90 MB, is downloaded once into the app's data folder
//! (checked against a known hash) and served from this computer at http://127.0.0.1, where the CAD
//! tab shows it in one of the Browser's pages (browser.rs: exports land in Downloads, files come in
//! through the page's own file picker). Designs it saves stay in that page's own storage, kept
//! between runs because the address (and so the port) stays the same.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const VERSION: &str = "0.25.1";
const SHA256: &str = "9a7b8ae8851d7f5777855b03818a4f349b3671b77a14e4e5ec153a902c66c5f9";
const MAX_DOWNLOAD: u64 = 60 * 1024 * 1024;
/// Ports tried in turn: the first free one is used, so the page's address (and with it the designs
/// kept in its storage) is normally the same every run.
const PORTS: [u16; 6] = [47318, 47319, 47320, 47321, 47322, 47323];

/// The address SolidCraft is served at, once started.
static SERVING: Mutex<Option<String>> = Mutex::new(None);

fn url() -> String {
    format!("https://github.com/bherbruck/solidcraft/releases/download/v{VERSION}/solidcraft-web-{VERSION}.zip")
}

fn site_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("tools").join(format!("solidcraft-web-{VERSION}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    installed: bool,
    version: &'static str,
    /// The download's size, to say before it starts.
    download_mb: u32,
}

#[tauri::command]
pub fn solidcraft_status(app: AppHandle) -> Result<Status, String> {
    Ok(Status { installed: site_dir(&app)?.join("index.html").is_file(), version: VERSION, download_mb: 30 })
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The site out of the release zip into `dir`: the zip's top folder is dropped, and names that
/// would land outside `dir` are refused.
fn unpack(zip_bytes: &[u8], dir: &Path) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| format!("Couldn't unpack it: {e}"))?;
    for i in 0..z.len() {
        let mut file = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = file.enclosed_name() else { return Err("The download had a file with an unsafe name".into()) };
        let inner: PathBuf = name.components().skip(1).collect();
        if inner.as_os_str().is_empty() {
            continue;
        }
        let to = dir.join(&inner);
        if file.is_dir() {
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&to).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
    }
    if !dir.join("index.html").is_file() {
        return Err("The download had no SolidCraft page in it".into());
    }
    Ok(())
}

fn install(app: &AppHandle) -> Result<(), String> {
    let dir = site_dir(app)?;
    if dir.join("index.html").is_file() {
        return Ok(());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .user_agent(concat!("BridgeDeck/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client.get(url()).send().map_err(|e| format!("Couldn't download SolidCraft: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The download answered {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    let mut bytes = Vec::with_capacity(total.min(MAX_DOWNLOAD) as usize);
    let mut buf = vec![0u8; 256 * 1024];
    let mut shown = u64::MAX;
    loop {
        let n = response.read(&mut buf).map_err(|e| format!("The download stopped: {e}"))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        if bytes.len() as u64 > MAX_DOWNLOAD {
            return Err("The download was bigger than expected".into());
        }
        let percent = (bytes.len() as u64 * 100).checked_div(total).unwrap_or(0);
        if percent != shown {
            shown = percent;
            let _ = app.emit_to("main", "solidcraft-progress", serde_json::json!({ "done": bytes.len(), "total": total }));
        }
    }
    if sha256_hex(&bytes) != SHA256 {
        return Err("The SolidCraft download didn't match the expected file, so it wasn't used. Try again later.".into());
    }
    let part = dir.with_extension("partial");
    let _ = std::fs::remove_dir_all(&part);
    std::fs::create_dir_all(&part).map_err(|e| e.to_string())?;
    if let Err(e) = unpack(&bytes, &part) {
        let _ = std::fs::remove_dir_all(&part);
        return Err(e);
    }
    std::fs::rename(&part, &dir).map_err(|e| e.to_string())
}

/// Downloads SolidCraft (once); progress arrives as `solidcraft-progress` events.
#[tauri::command]
pub async fn solidcraft_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install(&app)).await.map_err(|e| e.to_string())?
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ttf" => "font/ttf",
        "woff2" => "font/woff2",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The file a request asks for, inside `root` only ("/" is the page itself).
fn resolve(root: &Path, target: &str) -> Option<PathBuf> {
    let path = target.split(['?', '#']).next().unwrap_or("/");
    let decoded = crate::models::percent_decode(path).unwrap_or_else(|| path.to_string());
    let relative = Path::new(decoded.trim_start_matches('/'));
    if !relative.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let file = if relative.as_os_str().is_empty() { root.join("index.html") } else { root.join(relative) };
    file.is_file().then_some(file)
}

/// Requests from other sites' pages (a page naming another host, to reach this server through
/// a name that points here) are refused.
fn host_ok(host: &str, port: u16) -> bool {
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

fn answer(mut stream: TcpStream, root: &Path, port: u16) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut host = String::new();
    for _ in 0..100 {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("host") {
                host = value.trim().to_string();
            }
        }
    }
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
    let reply = |stream: &mut TcpStream, status: &str, kind: &str, body: &[u8], head_only: bool| {
        // The page and its offline helper are checked for changes each time; the rest is named by its hash.
        let header = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", body.len());
        let _ = stream.write_all(header.as_bytes());
        if !head_only {
            let _ = stream.write_all(body);
        }
    };
    if !host_ok(&host, port) {
        return reply(&mut stream, "403 Forbidden", "text/plain", b"Forbidden", false);
    }
    if method != "GET" && method != "HEAD" {
        return reply(&mut stream, "405 Method Not Allowed", "text/plain", b"", false);
    }
    match resolve(root, target).and_then(|f| std::fs::read(&f).ok().map(|b| (f, b))) {
        Some((file, body)) => reply(&mut stream, "200 OK", content_type(&file), &body, method == "HEAD"),
        None => reply(&mut stream, "404 Not Found", "text/plain", b"Not found", method == "HEAD"),
    }
}

/// Starts serving SolidCraft (once) and answers its address.
#[tauri::command]
pub fn solidcraft_serve(app: AppHandle) -> Result<String, String> {
    let mut serving = SERVING.lock().map_err(|_| "SolidCraft's server lock poisoned")?;
    if let Some(url) = serving.as_ref() {
        return Ok(url.clone());
    }
    let root = site_dir(&app)?;
    if !root.join("index.html").is_file() {
        return Err("SolidCraft isn't downloaded yet".into());
    }
    let (listener, port) = PORTS
        .iter()
        .find_map(|&port| TcpListener::bind(("127.0.0.1", port)).ok().map(|l| (l, port)))
        .ok_or("Couldn't start SolidCraft: its ports on this computer are all in use")?;
    std::thread::Builder::new()
        .name("solidcraft-server".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let root = root.clone();
                let _ = std::thread::Builder::new().name("solidcraft-request".into()).spawn(move || answer(stream, &root, port));
            }
        })
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/");
    *serving = Some(url.clone());
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_files_inside_the_site() {
        let root = std::env::temp_dir().join(format!("bd-solidcraft-{}", std::process::id()));
        std::fs::create_dir_all(root.join("icons")).unwrap();
        std::fs::write(root.join("index.html"), "<html>").unwrap();
        std::fs::write(root.join("icons").join("a b.png"), "png").unwrap();
        assert_eq!(resolve(&root, "/"), Some(root.join("index.html")));
        assert_eq!(resolve(&root, "/?webgl&sample"), Some(root.join("index.html")));
        assert_eq!(resolve(&root, "/icons/a%20b.png"), Some(root.join("icons").join("a b.png")));
        assert_eq!(resolve(&root, "/../secret"), None);
        assert_eq!(resolve(&root, "/icons/%2e%2e/%2e%2e/etc/passwd"), None);
        assert_eq!(resolve(&root, "/missing.js"), None);
        assert_eq!(content_type(Path::new("x_bg.wasm")), "application/wasm");
        assert!(host_ok("127.0.0.1:47318", 47318) && !host_ok("evil.example:47318", 47318));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unpacks_the_site_and_refuses_escaping_names() {
        use std::io::Write as _;
        let dir = std::env::temp_dir().join(format!("bd-solidcraft-unpack-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut ok = Vec::new();
        {
            let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut ok));
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("solidcraft-web-0.25.1/index.html", o).unwrap();
            z.write_all(b"<html>").unwrap();
            z.start_file("solidcraft-web-0.25.1/fonts/f.ttf", o).unwrap();
            z.write_all(b"font").unwrap();
            z.finish().unwrap();
        }
        unpack(&ok, &dir).unwrap();
        assert_eq!(std::fs::read(dir.join("fonts").join("f.ttf")).unwrap(), b"font");
        let mut bad = Vec::new();
        {
            let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut bad));
            z.start_file("../evil.txt", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
        }
        assert!(unpack(&bad, &dir.join("bad")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_download_is_pinned() {
        assert_eq!(SHA256.len(), 64);
        assert!(url().ends_with(&format!("v{VERSION}/solidcraft-web-{VERSION}.zip")));
    }
}
