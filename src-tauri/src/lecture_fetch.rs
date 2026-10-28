//! Lectures from a link: yt-dlp downloads a recorded lecture (Kaltura, Panopto, YouTube, or a
//! plain media link) as sound, into the course's Lectures folder, where it's transcribed like a
//! recording made here. Lectures behind a school sign-in use the browser's cookies when asked.
//! BridgeDeck can install yt-dlp (its GitHub release, into ~/.bridgedeck/tools) and update it.

use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

/// Sound first (small, and all transcription needs), as m4a where there's a choice; a video with
/// sound when that's all there is.
const FORMAT: &str = "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio[ext=webm]/best[ext=mp4]/best";
const BROWSERS: &[&str] = &["chrome", "safari", "firefox", "edge", "brave", "chromium"];
const LIMIT: Duration = Duration::from_secs(3 * 3600);

fn tool() -> Option<PathBuf> {
    crate::code::which("yt-dlp")
}

fn tools_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|h| PathBuf::from(h).join(".bridgedeck").join("tools"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchTool {
    pub path: Option<String>,
    pub version: String,
}

#[tauri::command]
pub async fn lecture_tool_status() -> FetchTool {
    tauri::async_runtime::spawn_blocking(|| match tool() {
        Some(path) => {
            let version = crate::python::command(&[path.to_string_lossy().into_owned(), "--version".into()]).stdin(Stdio::null()).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
            FetchTool { path: Some(path.to_string_lossy().into_owned()), version }
        }
        None => FetchTool { path: None, version: String::new() },
    })
    .await
    .unwrap_or(FetchTool { path: None, version: String::new() })
}

fn release_asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", _) => Some("yt-dlp_macos"),
        ("windows", _) => Some("yt-dlp.exe"),
        ("linux", "x86_64") => Some("yt-dlp_linux"),
        ("linux", "aarch64") => Some("yt-dlp_linux_aarch64"),
        _ => None,
    }
}

/// Installs yt-dlp, or updates the copy BridgeDeck installed (sites change, and yt-dlp follows them).
#[tauri::command]
pub async fn lecture_tool_install() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = tools_dir().ok_or("No home folder")?;
        let path = dir.join(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" });
        let asset = release_asset().ok_or("There's no yt-dlp for this kind of computer")?;
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(600)).user_agent("BridgeDeck").build().map_err(|e| e.to_string())?;
        let bytes = client.get(format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset}")).send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes()).map_err(|e| format!("Couldn't download yt-dlp: {e}"))?;
        if bytes.len() < 1_000_000 {
            return Err("The download wasn't yt-dlp".into());
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let partial = path.with_extension("partial");
        fs::write(&partial, &bytes).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&partial, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        fs::rename(&partial, &path).map_err(|e| e.to_string())?;
        crate::activity::info("study", &format!("Installed yt-dlp in {}.", dir.display()));
        Ok(format!("yt-dlp is in {}.", dir.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A link yt-dlp may be given: http(s) only, and never something it could take for an option.
pub fn valid_link(url: &str) -> bool {
    let url = url.trim();
    url.len() < 2048 && (url.starts_with("https://") || url.starts_with("http://")) && !url.contains(char::is_whitespace)
}

/// "[download]  42.3% of ~ 12.34MiB at 1.2MiB/s ETA 00:10" → 42.3.
pub fn progress_of(line: &str) -> Option<f64> {
    let rest = line.trim().strip_prefix("[download]")?.trim_start();
    let pct = rest.split('%').next()?.trim();
    pct.parse::<f64>().ok().filter(|p| (0.0..=100.0).contains(p))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FetchProgress {
    url: String,
    percent: f64,
}

/// Downloads a lecture from `url` into the course's Lectures folder; returns its file name there.
/// `browser` is whose sign-in to use for a lecture behind a school login (its cookies), if any.
#[tauri::command]
pub async fn lecture_fetch(app: AppHandle, course_name: String, url: String, browser: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = url.trim().to_string();
        if !valid_link(&url) {
            return Err("Paste the lecture's link (starting https://)".into());
        }
        if let Some(b) = &browser {
            if !BROWSERS.contains(&b.as_str()) {
                return Err("That browser isn't one yt-dlp can use".into());
            }
        }
        let course = crate::study_lectures::course(&course_name)?;
        let ytdlp = tool().ok_or("yt-dlp isn't installed: press Install yt-dlp.")?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let tmp = std::env::temp_dir().join(format!("bridgedeck-lecture-{stamp}"));
        fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let mut args: Vec<String> = vec![
            ytdlp.to_string_lossy().into_owned(),
            "--newline".into(),
            // --print makes it quiet; this keeps the progress lines coming.
            "--progress".into(),
            "--no-playlist".into(),
            "--no-mtime".into(),
            "-f".into(),
            FORMAT.into(),
            "-o".into(),
            tmp.join("%(title).90B.%(ext)s").to_string_lossy().into_owned(),
            "--print".into(),
            "after_move:filepath".into(),
            "--no-simulate".into(),
        ];
        if let Some(b) = &browser {
            args.push("--cookies-from-browser".into());
            args.push(b.clone());
        }
        // The link after "--", so it can never be read as an option.
        args.push("--".into());
        args.push(url.clone());
        let result = (|| {
            let mut child = crate::python::command(&args).env("PATH", crate::code::joined_path()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Couldn't start yt-dlp: {e}"))?;
            let mut err = child.stderr.take().unwrap();
            let errors = std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
            let started = Instant::now();
            let mut saved: Option<PathBuf> = None;
            let mut last = -1.0;
            for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
                if let Some(p) = progress_of(&line) {
                    if p - last >= 1.0 || p >= 100.0 {
                        last = p;
                        let _ = app.emit("lecture-fetch", FetchProgress { url: url.clone(), percent: p });
                    }
                } else if Path::new(line.trim()).is_file() {
                    saved = Some(PathBuf::from(line.trim()));
                }
                if started.elapsed() > LIMIT {
                    let _ = child.kill();
                    return Err("The download took too long".to_string());
                }
            }
            let status = child.wait().map_err(|e| e.to_string())?;
            let errors = errors.join().unwrap_or_default();
            let Some(file) = saved.filter(|_| status.success()) else {
                let why = errors.lines().filter(|l| l.contains("ERROR")).last().unwrap_or("").replace("ERROR: ", "");
                return Err(if why.is_empty() { "yt-dlp couldn't download it".into() } else if why.contains("login") || why.contains("sign in") || why.contains("403") || why.contains("401") { format!("{why}. If the lecture is behind your school's sign-in, choose the browser you're signed in with.") } else { why });
            };
            crate::study_lectures::import_recording(&course, &file)
        })();
        let _ = fs::remove_dir_all(&tmp);
        if let Ok(file) = &result {
            crate::activity::info("study", &format!("Downloaded a lecture into {course_name}: {file}"));
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_progress_and_checks_links() {
        assert_eq!(progress_of("[download]  42.3% of ~  12.34MiB at    1.20MiB/s ETA 00:10"), Some(42.3));
        assert_eq!(progress_of("[download] 100% of   12.34MiB in 00:00:10 at 1.2MiB/s"), Some(100.0));
        assert_eq!(progress_of("[download] Destination: /tmp/x.m4a"), None);
        assert_eq!(progress_of("[youtube] abc: Downloading webpage"), None);
        assert!(valid_link("https://ucla.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=abc"));
        assert!(!valid_link("--exec rm"));
        assert!(!valid_link("file:///etc/passwd"));
        assert!(!valid_link("https://a.b/x y"));
    }
}
