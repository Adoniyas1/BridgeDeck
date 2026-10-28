//! Arduino in the Code tab: arduino-cli builds sketches (for the simulated Uno, which runs the HEX
//! file in the window, or for a real board) and uploads them over USB. BridgeDeck can install
//! arduino-cli itself (from its GitHub releases, into ~/.bridgedeck/tools) and the Uno's tools.

use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{Duration, Instant},
};

const CLI_VERSION: &str = "1.3.1";
const MAX_SKETCH: usize = 256 * 1024;
/// One build or upload at a time (they share a folder).
static BUSY: Mutex<()> = Mutex::new(());

fn tools_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|h| PathBuf::from(h).join(".bridgedeck").join("tools"))
}

fn cli() -> Option<PathBuf> {
    crate::code::which("arduino-cli")
}

/// Runs arduino-cli; its output (both streams) and whether it worked.
fn run(cli: &Path, args: &[&str], limit: Duration) -> Result<(bool, String), String> {
    let mut command = crate::python::command(&std::iter::once(cli.to_string_lossy().into_owned()).chain(args.iter().map(|a| a.to_string())).collect::<Vec<_>>());
    let mut child = command.env("PATH", crate::code::joined_path()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Couldn't start arduino-cli: {e}"))?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let reader = std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
    let started = Instant::now();
    let mut text = String::new();
    let _ = out.read_to_string(&mut text);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            text.push_str(&reader.join().unwrap_or_default());
            return Ok((status.success(), text));
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            return Err("arduino-cli took too long".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArduinoStatus {
    /// Where arduino-cli is, if it's anywhere.
    pub cli: Option<String>,
    pub version: String,
    /// Whether the tools for AVR boards (Uno, Nano, Mega) are installed.
    pub avr: bool,
}

/// Whether arduino-cli's installed platforms include the AVR boards'.
pub fn has_avr(core_list_json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(core_list_json) else { return false };
    let list = v.get("platforms").and_then(Value::as_array).cloned().or_else(|| v.as_array().cloned()).unwrap_or_default();
    list.iter().any(|p| p.get("id").and_then(Value::as_str) == Some("arduino:avr") && p.get("installed_version").or_else(|| p.get("installed")).is_some_and(|i| !i.is_null() && i.as_str() != Some("")))
}

#[tauri::command]
pub async fn arduino_status() -> ArduinoStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(cli) = cli() else { return ArduinoStatus { cli: None, version: String::new(), avr: false } };
        let version = run(&cli, &["version"], Duration::from_secs(20)).map(|(_, t)| t.lines().next().unwrap_or("").trim().to_string()).unwrap_or_default();
        let avr = run(&cli, &["core", "list", "--format", "json"], Duration::from_secs(30)).is_ok_and(|(ok, t)| ok && has_avr(&t));
        ArduinoStatus { cli: Some(cli.to_string_lossy().into_owned()), version, avr }
    })
    .await
    .unwrap_or(ArduinoStatus { cli: None, version: String::new(), avr: false })
}

/// The release file for this computer.
fn release_asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macOS_ARM64.tar.gz"),
        ("macos", _) => Some("macOS_64bit.tar.gz"),
        ("windows", "x86_64") => Some("Windows_64bit.zip"),
        ("linux", "x86_64") => Some("Linux_64bit.tar.gz"),
        ("linux", "aarch64") => Some("Linux_ARM64.tar.gz"),
        _ => None,
    }
}

/// arduino-cli's program out of its release archive (a .tar.gz, or a .zip on Windows).
pub fn extract_cli(archive: &[u8], zip: bool) -> Result<Vec<u8>, String> {
    let want = if zip { "arduino-cli.exe" } else { "arduino-cli" };
    if zip {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(archive)).map_err(|e| e.to_string())?;
        for i in 0..z.len() {
            let mut f = z.by_index(i).map_err(|e| e.to_string())?;
            if Path::new(f.name()).file_name().is_some_and(|n| n == want) {
                let mut bytes = Vec::new();
                f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                return Ok(bytes);
            }
        }
    } else {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            if entry.path().ok().and_then(|p| p.file_name().map(|n| n == want)).unwrap_or(false) {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                return Ok(bytes);
            }
        }
    }
    Err("arduino-cli wasn't in the download".into())
}

/// Installs arduino-cli (if it isn't anywhere) and the AVR boards' tools. Needs the internet; the
/// boards' tools are about 150 MB and take a few minutes. Returns what it did.
#[tauri::command]
pub async fn arduino_setup() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut log = Vec::new();
        let cli = match cli() {
            Some(c) => c,
            None => {
                let asset = release_asset().ok_or("There's no arduino-cli for this kind of computer")?;
                let url = format!("https://github.com/arduino/arduino-cli/releases/download/v{CLI_VERSION}/arduino-cli_{CLI_VERSION}_{asset}");
                let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(600)).user_agent("BridgeDeck").build().map_err(|e| e.to_string())?;
                let bytes = client.get(&url).send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes()).map_err(|e| format!("Couldn't download arduino-cli: {e}"))?;
                let program = extract_cli(&bytes, asset.ends_with(".zip"))?;
                let dir = tools_dir().ok_or("No home folder")?;
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let path = dir.join(if cfg!(windows) { "arduino-cli.exe" } else { "arduino-cli" });
                fs::write(&path, program).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
                }
                log.push(format!("Installed arduino-cli {CLI_VERSION} in {}.", dir.display()));
                path
            }
        };
        let (ok, text) = run(&cli, &["core", "update-index"], Duration::from_secs(300))?;
        if !ok {
            return Err(format!("Couldn't get the list of boards: {}", text.trim()));
        }
        let (ok, text) = run(&cli, &["core", "install", "arduino:avr"], Duration::from_secs(1200))?;
        if !ok {
            return Err(format!("Couldn't install the tools for Arduino Uno, Nano and Mega: {}", text.trim()));
        }
        log.push("Installed the tools for Arduino Uno, Nano and Mega (arduino:avr).".into());
        crate::activity::info("code", &log.join(" "));
        Ok(log.join("\n"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArduinoBuild {
    pub ok: bool,
    /// What the compiler (and the upload) said.
    pub output: String,
    /// The program as an Intel HEX file, for the simulator (AVR boards).
    pub hex: Option<String>,
    pub ms: u64,
}

/// A board name arduino-cli accepts ("arduino:avr:uno"); never one it could take for an option.
fn valid_fqbn(fqbn: &str) -> bool {
    let parts: Vec<&str> = fqbn.split(':').collect();
    fqbn.starts_with(|c: char| c.is_ascii_alphanumeric()) && parts.len() >= 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "_-.=,".contains(c)))
}

fn sketch_dirs() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join("bridgedeck-arduino");
    (root.join("sketch"), root.join("build"))
}

fn compile(source: &str, fqbn: &str) -> Result<ArduinoBuild, String> {
    if source.len() > MAX_SKETCH {
        return Err("That sketch is too long".into());
    }
    if !valid_fqbn(fqbn) {
        return Err("That isn't a board arduino-cli knows".into());
    }
    let cli = cli().ok_or("arduino-cli isn't installed: press Set up Arduino.")?;
    let (sketch, build) = sketch_dirs();
    let _ = fs::remove_dir_all(&build);
    fs::create_dir_all(&sketch).map_err(|e| e.to_string())?;
    fs::write(sketch.join("sketch.ino"), source).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let (ok, output) = run(&cli, &["compile", "--fqbn", fqbn, "--output-dir", &build.to_string_lossy(), &sketch.to_string_lossy()], Duration::from_secs(300))?;
    let hex = if ok { fs::read_to_string(build.join("sketch.ino.hex")).ok() } else { None };
    Ok(ArduinoBuild { ok, output, hex, ms: started.elapsed().as_millis() as u64 })
}

#[tauri::command]
pub async fn arduino_compile(source: String, fqbn: String) -> Result<ArduinoBuild, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _one = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        compile(&source, &fqbn)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArduinoPort {
    pub address: String,
    pub label: String,
    /// The board recognised on it, and its name for arduino-cli.
    pub board: Option<String>,
    pub fqbn: Option<String>,
}

/// The serial ports in `board list --format json`, boards first.
pub fn parse_ports(json: &str) -> Vec<ArduinoPort> {
    let Ok(v) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    let list = v.get("detected_ports").and_then(Value::as_array).cloned().or_else(|| v.as_array().cloned()).unwrap_or_default();
    let mut ports: Vec<ArduinoPort> = list
        .iter()
        .filter_map(|p| {
            let port = p.get("port")?;
            if port.get("protocol").and_then(Value::as_str).is_some_and(|x| x != "serial") {
                return None;
            }
            let board = p.get("matching_boards").and_then(Value::as_array).and_then(|b| b.first());
            Some(ArduinoPort {
                address: port.get("address")?.as_str()?.to_string(),
                label: port.get("protocol_label").or_else(|| port.get("label")).and_then(Value::as_str).unwrap_or("").to_string(),
                board: board.and_then(|b| b.get("name")).and_then(Value::as_str).map(str::to_string),
                fqbn: board.and_then(|b| b.get("fqbn")).and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect();
    ports.sort_by_key(|p| p.board.is_none());
    ports
}

#[tauri::command]
pub async fn arduino_ports() -> Result<Vec<ArduinoPort>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let cli = cli().ok_or("arduino-cli isn't installed: press Set up Arduino.")?;
        let (_, text) = run(&cli, &["board", "list", "--format", "json"], Duration::from_secs(30))?;
        Ok(parse_ports(&text))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Builds the sketch and puts it on the board at `port`.
#[tauri::command]
pub async fn arduino_upload(source: String, fqbn: String, port: String) -> Result<ArduinoBuild, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _one = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        if port.is_empty() || port.len() > 200 || port.starts_with('-') {
            return Err("Pick the board's port".into());
        }
        let mut built = compile(&source, &fqbn)?;
        if !built.ok {
            return Ok(built);
        }
        let cli = cli().ok_or("arduino-cli isn't installed")?;
        let (_, build) = sketch_dirs();
        let started = Instant::now();
        let (ok, text) = run(&cli, &["upload", "-p", &port, "--fqbn", &fqbn, "--input-dir", &build.to_string_lossy()], Duration::from_secs(180))?;
        built.ok = ok;
        built.output = format!("{}\n{}", built.output.trim_end(), text.trim());
        built.ms += started.elapsed().as_millis() as u64;
        Ok(built)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_installed_platforms_and_ports() {
        assert!(has_avr(r#"{"platforms":[{"id":"arduino:avr","installed_version":"1.8.6","latest_version":"1.8.6"}]}"#));
        assert!(!has_avr(r#"{"platforms":[{"id":"esp32:esp32","installed_version":"3.0.0"}]}"#));
        assert!(!has_avr(r#"{}"#));
        let ports = parse_ports(r#"{"detected_ports":[
            {"port":{"address":"/dev/cu.Bluetooth-Incoming-Port","label":"/dev/cu.Bluetooth-Incoming-Port","protocol":"serial","protocol_label":"Serial Port"}},
            {"port":{"address":"/dev/cu.usbmodem1101","label":"/dev/cu.usbmodem1101","protocol":"serial","protocol_label":"Serial Port (USB)"},"matching_boards":[{"name":"Arduino Uno","fqbn":"arduino:avr:uno"}]},
            {"port":{"address":"192.168.1.5","protocol":"network","label":"esp"}}]}"#);
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0], ArduinoPort { address: "/dev/cu.usbmodem1101".into(), label: "Serial Port (USB)".into(), board: Some("Arduino Uno".into()), fqbn: Some("arduino:avr:uno".into()) });
        assert_eq!(ports[1].board, None);
    }

    #[test]
    fn checks_board_names() {
        assert!(valid_fqbn("arduino:avr:uno"));
        assert!(valid_fqbn("arduino:avr:nano:cpu=atmega328old"));
        assert!(valid_fqbn("esp32:esp32:esp32-s3"));
        assert!(!valid_fqbn("arduino:avr"));
        assert!(!valid_fqbn("arduino:avr:uno; rm -rf /"));
        assert!(!valid_fqbn("--config-file:x:y"));
    }

    #[test]
    fn takes_the_program_out_of_a_release() {
        let mut tgz = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut tgz, flate2::Compression::fast());
            let mut tar = tar::Builder::new(gz);
            let mut header = tar::Header::new_gnu();
            header.set_size(4);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, "LICENSE.txt", &b"text"[..]).unwrap();
            let mut header = tar::Header::new_gnu();
            header.set_size(3);
            header.set_cksum();
            tar.append_data(&mut header, "arduino-cli", &b"elf"[..]).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }
        assert_eq!(extract_cli(&tgz, false).unwrap(), b"elf");
        assert!(extract_cli(b"not an archive", true).is_err());
    }
}
