//! The Spotify tab's "Spotify app" side: what the Spotify desktop app is playing on this computer,
//! and play/pause/skip (and volume on the Mac). macOS: AppleScript (the first use asks to let
//! BridgeDeck control Spotify). Windows: the system's media controls for Spotify's session.

use serde::Serialize;

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    /// This computer can control the Spotify app.
    pub supported: bool,
    /// The app is open (with something loaded).
    pub running: bool,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// A picture of the album: a web address (Mac) or a data URL (Windows).
    pub artwork: String,
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    /// 0–100 (Mac only).
    pub volume: Option<u8>,
    pub error: String,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// The Mac script's answer: state, name, artist, album, artwork, position (ms), duration (ms),
/// volume, one per line; "notrunning" or "stopped" otherwise.
pub fn parse_mac(text: &str) -> NowPlaying {
    let text = text.trim_end_matches(['\r', '\n']);
    let base = NowPlaying { supported: true, ..Default::default() };
    if text == "notrunning" {
        return base;
    }
    if text == "stopped" {
        return NowPlaying { running: true, ..base };
    }
    let parts: Vec<&str> = text.split('\n').collect();
    if parts.len() < 8 {
        return NowPlaying { error: "Spotify gave an answer BridgeDeck can't read".into(), ..base };
    }
    NowPlaying {
        running: true,
        playing: parts[0] == "playing",
        title: parts[1].to_string(),
        artist: parts[2].to_string(),
        album: parts[3].to_string(),
        artwork: if parts[4].starts_with("https://") { parts[4].to_string() } else { String::new() },
        position_ms: parts[5].trim().parse::<f64>().ok().map(|v| v.max(0.0) as u64),
        duration_ms: parts[6].trim().parse::<f64>().ok().map(|v| v.max(0.0) as u64),
        volume: parts[7].trim().parse::<f64>().ok().map(|v| v.clamp(0.0, 100.0) as u8),
        ..base
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::process::Command;

    const STATUS: &str = r#"if application "Spotify" is running then
  tell application "Spotify"
    set s to player state as string
    if s is "stopped" then return "stopped"
    set t to current track
    return s & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (album of t) & linefeed & (artwork url of t) & linefeed & ((player position * 1000) as integer as string) & linefeed & ((duration of t) as string) & linefeed & (sound volume as string)
  end tell
else
  return "notrunning"
end if"#;

    fn run(script: &str) -> Result<String, String> {
        let out = Command::new("osascript").arg("-e").arg(script).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let error = String::from_utf8_lossy(&out.stderr);
        Err(if error.contains("-1743") || error.contains("Not authorized") {
            "Allow BridgeDeck to control Spotify: System Settings → Privacy & Security → Automation → BridgeDeck → Spotify.".into()
        } else {
            error.trim().to_string()
        })
    }

    pub fn status() -> NowPlaying {
        match run(STATUS) {
            Ok(text) => parse_mac(&text),
            Err(error) => NowPlaying { supported: true, error, ..Default::default() },
        }
    }

    pub fn control(action: &str, value: Option<u8>) -> Result<(), String> {
        let command = match action {
            "playpause" => "playpause".to_string(),
            "next" => "next track".to_string(),
            "previous" => "previous track".to_string(),
            "volume" => format!("set sound volume to {}", value.unwrap_or(50).min(100)),
            _ => return Err("Unknown action".into()),
        };
        // Only when it's open: telling a closed Spotify to do something would open it.
        run(&format!("if application \"Spotify\" is running then tell application \"Spotify\" to {command}")).map(|_| ())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use base64::Engine;
    use std::sync::Mutex;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    /// The last album picture, by "artist/album", so it's read once per album.
    static ARTWORK: Mutex<Option<(String, String)>> = Mutex::new(None);

    fn init() {
        // WinRT on this worker thread (an error means it was already set up).
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
    }

    fn session() -> windows::core::Result<Option<Session>> {
        let manager = Manager::RequestAsync()?.join()?;
        let sessions = manager.GetSessions()?;
        for session in sessions {
            if session.SourceAppUserModelId()?.to_string().to_lowercase().contains("spotify") {
                return Ok(Some(session));
            }
        }
        Ok(None)
    }

    fn artwork(session: &Session, key: &str) -> String {
        if let Some((k, v)) = ARTWORK.lock().ok().and_then(|a| a.clone()) {
            if k == key {
                return v;
            }
        }
        let read = || -> windows::core::Result<Vec<u8>> {
            let props = session.TryGetMediaPropertiesAsync()?.join()?;
            let stream = props.Thumbnail()?.OpenReadAsync()?.join()?;
            let size = stream.Size()? as u32;
            if size == 0 || size > 2_000_000 {
                return Ok(Vec::new());
            }
            let reader = DataReader::CreateDataReader(&stream)?;
            reader.LoadAsync(size)?.join()?;
            let mut bytes = vec![0u8; size as usize];
            reader.ReadBytes(&mut bytes)?;
            Ok(bytes)
        };
        let url = match read() {
            Ok(bytes) if !bytes.is_empty() => {
                let kind = if bytes.starts_with(&[0x89, b'P']) { "png" } else { "jpeg" };
                format!("data:image/{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
            }
            _ => String::new(),
        };
        if let Ok(mut a) = ARTWORK.lock() {
            *a = Some((key.to_string(), url.clone()));
        }
        url
    }

    pub fn status() -> NowPlaying {
        init();
        let read = || -> windows::core::Result<NowPlaying> {
            let Some(session) = session()? else { return Ok(NowPlaying { supported: true, ..Default::default() }) };
            let props = session.TryGetMediaPropertiesAsync()?.join()?;
            let playing = session.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing;
            let timeline = session.GetTimelineProperties()?;
            let ms = |ticks: i64| (ticks.max(0) / 10_000) as u64;
            let (title, artist, album) = (props.Title()?.to_string(), props.Artist()?.to_string(), props.AlbumTitle()?.to_string());
            let duration = ms(timeline.EndTime()?.Duration);
            Ok(NowPlaying {
                supported: true,
                running: true,
                playing,
                artwork: artwork(&session, &format!("{artist}/{album}/{title}")),
                title,
                artist,
                album,
                position_ms: Some(ms(timeline.Position()?.Duration)),
                duration_ms: (duration > 0).then_some(duration),
                ..Default::default()
            })
        };
        read().unwrap_or_else(|e| NowPlaying { supported: true, error: e.message().to_string(), ..Default::default() })
    }

    pub fn control(action: &str, _value: Option<u8>) -> Result<(), String> {
        init();
        let session = session().map_err(|e| e.message().to_string())?.ok_or("Spotify isn't playing anything")?;
        let done = match action {
            "playpause" => session.TryTogglePlayPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            "previous" => session.TrySkipPreviousAsync(),
            "volume" => return Err("Change Spotify's volume in Spotify on Windows".into()),
            _ => return Err("Unknown action".into()),
        };
        done.and_then(|op| op.join()).map(|_| ()).map_err(|e| e.message().to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    pub fn status() -> NowPlaying {
        NowPlaying::default()
    }
    pub fn control(_action: &str, _value: Option<u8>) -> Result<(), String> {
        Err("Controlling the Spotify app works on Mac and Windows".into())
    }
}

#[tauri::command]
pub async fn spotify_status() -> NowPlaying {
    tauri::async_runtime::spawn_blocking(platform::status).await.unwrap_or_default()
}

#[tauri::command]
pub async fn spotify_control(action: String, value: Option<u8>) -> Result<NowPlaying, String> {
    tauri::async_runtime::spawn_blocking(move || {
        platform::control(&action, value)?;
        // The app takes a moment to change track.
        std::thread::sleep(std::time::Duration::from_millis(250));
        Ok(platform::status())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the Spotify app.
#[tauri::command]
pub fn spotify_open(app: tauri::AppHandle) -> Result<(), String> {
    tauri_plugin_opener::OpenerExt::opener(&app).open_url("spotify:", None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_the_mac_app_says() {
        assert_eq!(parse_mac("notrunning\n"), NowPlaying { supported: true, ..Default::default() });
        assert!(parse_mac("stopped").running);
        let now = parse_mac("playing\nSo What\nMiles Davis\nKind of Blue\nhttps://i.scdn.co/image/abc\n61234\n562000\n70\n");
        assert!(now.running && now.playing);
        assert_eq!((now.title.as_str(), now.artist.as_str(), now.album.as_str()), ("So What", "Miles Davis", "Kind of Blue"));
        assert_eq!((now.position_ms, now.duration_ms, now.volume), (Some(61234), Some(562000), Some(70)));
        assert_eq!(now.artwork, "https://i.scdn.co/image/abc");
        assert!(!parse_mac("paused\nA\nB\nC\nfile:///x\n1\n2\n3").playing);
        assert_eq!(parse_mac("paused\nA\nB\nC\nfile:///x\n1\n2\n3").artwork, "");
        assert!(!parse_mac("garbage").error.is_empty());
    }
}
