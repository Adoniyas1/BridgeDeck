//! Notes as a clean typeset PDF, made with Typst (downloaded once into the app's data folder, about
//! 15 MB). Math written as LaTeX is typeset by the mitex package, which Typst fetches itself the
//! first time. Two looks: a clean book font, or a neat handwriting-style font (Kalam, also fetched
//! once). The Typst source comes from the window (src/features/notes/typst.ts).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

const VERSION: &str = "0.13.1";
const FONTS: &[(&str, &str)] = &[
    ("Kalam-Regular.ttf", "https://github.com/google/fonts/raw/main/ofl/kalam/Kalam-Regular.ttf"),
    ("Kalam-Bold.ttf", "https://github.com/google/fonts/raw/main/ofl/kalam/Kalam-Bold.ttf"),
];

/// The release archive for this computer, and its SHA-256 (the download is checked against it
/// before the program in it is ever run).
fn asset() -> Result<(&'static str, &'static str), String> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("typst-aarch64-apple-darwin.tar.xz", "541e4f9eaca3f34ee865f81fc663e4839cb84d6253f71a372cd855b0a7283213"),
        ("macos", _) => ("typst-x86_64-apple-darwin.tar.xz", "4dabfe647f7f01ed9cc13ad8196a6c7f5e16f0732821b522d50740d3a9f5207b"),
        ("windows", _) => ("typst-x86_64-pc-windows-msvc.zip", "44170d0632298ba68cbabc43dbfb6908b17ca9236859e0767b0e5d54b2d19f48"),
        ("linux", "aarch64") => ("typst-aarch64-unknown-linux-musl.tar.xz", "4f5b7ee6e57fb639019ee0f6bffcf940edad228ede6ff5269a9f05a1544ceed4"),
        ("linux", _) => ("typst-x86_64-unknown-linux-musl.tar.xz", "7d214bfeffc2e585dc422d1a09d2b144969421281e8c7f5d784b65fc69b5673f"),
        _ => return Err("Typeset PDFs aren't available on this computer".into()),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("tools").join(format!("typst-{VERSION}")))
}

fn fetch(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(300)).user_agent(concat!("BridgeDeck/", env!("CARGO_PKG_VERSION"))).build().map_err(|e| e.to_string())?;
    let response = client.get(url).send().map_err(|e| format!("Couldn't download it: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The download answered {}", response.status()));
    }
    let mut bytes = Vec::new();
    response.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("The download was bigger than expected".into());
    }
    Ok(bytes)
}

/// The `typst` program out of a release archive (.tar.xz or .zip).
pub fn extract_program(archive: &[u8], zip: bool) -> Result<Vec<u8>, String> {
    let wanted = |name: &str| name.ends_with("/typst") || name.ends_with("/typst.exe") || name == "typst" || name == "typst.exe";
    if zip {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(archive)).map_err(|e| e.to_string())?;
        for i in 0..z.len() {
            let mut file = z.by_index(i).map_err(|e| e.to_string())?;
            if wanted(file.name()) {
                let mut out = Vec::new();
                file.read_to_end(&mut out).map_err(|e| e.to_string())?;
                return Ok(out);
            }
        }
    } else {
        let mut tar_bytes = Vec::new();
        lzma_rs::xz_decompress(&mut std::io::Cursor::new(archive), &mut tar_bytes).map_err(|e| format!("Couldn't unpack it: {e}"))?;
        let mut tar = tar::Archive::new(std::io::Cursor::new(tar_bytes));
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let name = entry.path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
            if wanted(&name) {
                let mut out = Vec::new();
                entry.read_to_end(&mut out).map_err(|e| e.to_string())?;
                return Ok(out);
            }
        }
    }
    Err("The download had no typst program in it".into())
}

/// Typst and the fonts, downloaded the first time.
fn ensure(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dir = tools_dir(app)?;
    let program = dir.join(if cfg!(windows) { "typst.exe" } else { "typst" });
    let fonts = dir.join("fonts");
    std::fs::create_dir_all(&fonts).map_err(|e| e.to_string())?;
    if !program.is_file() {
        let (name, sha) = asset()?;
        let archive = fetch(&format!("https://github.com/typst/typst/releases/download/v{VERSION}/{name}"), 80 * 1024 * 1024)?;
        if sha256_hex(&archive) != sha {
            return Err("The Typst download didn't match the expected file, so it wasn't used. Try again later.".into());
        }
        let bytes = extract_program(&archive, name.ends_with(".zip"))?;
        let part = program.with_extension("partial");
        std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&part, &program).map_err(|e| e.to_string())?;
    }
    for (file, url) in FONTS {
        if !fonts.join(file).is_file() {
            // A missing handwriting font only changes the look: Typst falls back to its own.
            if let Ok(bytes) = fetch(url, 2 * 1024 * 1024) {
                let _ = std::fs::write(fonts.join(file), bytes);
            }
        }
    }
    Ok((program, fonts))
}

pub fn compile(program: &Path, fonts: &Path, source: &str, work: &Path) -> Result<Vec<u8>, String> {
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let (input, output) = (work.join("note.typ"), work.join("note.pdf"));
    std::fs::write(&input, source).map_err(|e| e.to_string())?;
    let result = Command::new(program).arg("compile").arg("--font-path").arg(fonts).arg(&input).arg(&output).output().map_err(|e| format!("Typst didn't run: {e}"))?;
    if !result.status.success() {
        let message = String::from_utf8_lossy(&result.stderr);
        return Err(format!("Typst couldn't make it: {}", message.lines().take(6).collect::<Vec<_>>().join(" ")));
    }
    std::fs::read(&output).map_err(|e| e.to_string())
}

/// The note (as Typst source) typeset into a PDF, returned as base64.
#[tauri::command]
pub async fn typst_pdf(app: AppHandle, source: String) -> Result<String, String> {
    if source.len() > 4 * 1024 * 1024 {
        return Err("That note is too long to typeset".into());
    }
    let work = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("typst").join(uuid::Uuid::new_v4().to_string());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (program, fonts) = ensure(&app)?;
        let pdf = compile(&program, &fonts, &source, &work);
        let _ = std::fs::remove_dir_all(&work);
        pdf
    })
    .await
    .map_err(|e| e.to_string())??;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn downloads_are_checked_against_a_known_hash() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let (_, sha) = asset().unwrap();
        assert_eq!(sha.len(), 64);
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_program_comes_out_of_either_archive() {
        let mut zip_bytes = Vec::new();
        {
            let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_bytes));
            z.start_file("typst-x86_64-pc-windows-msvc/README.md", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"readme").unwrap();
            z.start_file("typst-x86_64-pc-windows-msvc/typst.exe", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"MZ program").unwrap();
            z.finish().unwrap();
        }
        assert_eq!(extract_program(&zip_bytes, true).unwrap(), b"MZ program");
        let mut tar_bytes = Vec::new();
        {
            let mut t = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_size(7);
            header.set_cksum();
            t.append_data(&mut header, "typst-x86_64-apple-darwin/typst", &b"program"[..]).unwrap();
            t.finish().unwrap();
        }
        let mut xz = Vec::new();
        lzma_rs::xz_compress(&mut std::io::Cursor::new(&tar_bytes), &mut xz).unwrap();
        assert_eq!(extract_program(&xz, false).unwrap(), b"program");
        assert!(extract_program(b"nonsense", false).is_err());
    }
}
