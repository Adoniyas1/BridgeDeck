//! Presentations in the Study reader. PowerPoint, Keynote and OpenDocument slides are turned into a
//! PDF once on each computer, with an app it already has (Keynote on a Mac, PowerPoint on Windows,
//! LibreOffice anywhere), and then read like any PDF book. The PDF is kept in the app data folder,
//! not the synced library: the other computer makes its own, so nothing is synced twice and a
//! presentation that changes is simply converted again.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

/// Where the PDFs of presentations are kept (`<app data>/study-slides/<course>/<file>.pdf`).
static DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
/// One conversion at a time: Keynote and PowerPoint don't like being driven twice at once.
static CONVERTING: Mutex<()> = Mutex::new(());
/// A conversion that hasn't finished by then (an app waiting on a dialog) is stopped.
const TIMEOUT: Duration = Duration::from_secs(180);

pub fn init(app_data: &Path) {
    if let Ok(mut dir) = DIR.lock() {
        *dir = Some(app_data.join("study-slides"));
    }
}

/// LibreOffice's own settings for BridgeDeck's conversions, kept so it is set up only once.
fn profile_dir() -> Option<PathBuf> {
    DIR.lock().ok()?.as_ref().map(|dir| dir.join(".libreoffice-profile"))
}

fn cache_path(course: &str, file: &str) -> Option<PathBuf> {
    DIR.lock().ok()?.as_ref().map(|dir| dir.join(course).join(format!("{file}.pdf")))
}

/// The PDF made from a presentation, if there is one at least as new as the presentation.
pub fn cached(source: &Path) -> Option<PathBuf> {
    let course = source.parent()?.file_name()?.to_str()?;
    let file = source.file_name()?.to_str()?;
    let pdf = cache_path(course, file)?;
    let made = fs::metadata(&pdf).ok()?.modified().ok()?;
    let changed = fs::metadata(source).ok()?.modified().ok()?;
    (made >= changed).then_some(pdf)
}

/// Forgets a presentation's PDF (when it is removed from the library).
pub fn forget(course: &str, file: &str) {
    if let Some(pdf) = cache_path(course, file) {
        let _ = fs::remove_file(pdf);
    }
}

/// Makes the PDF of a presentation in the library, unless an up-to-date one is already kept.
pub fn ensure_pdf(source: &Path) -> Result<PathBuf, String> {
    if let Some(pdf) = cached(source) {
        return Ok(pdf);
    }
    let _one_at_a_time = CONVERTING.lock().map_err(|_| "Another conversion failed; try again")?;
    if let Some(pdf) = cached(source) {
        return Ok(pdf);
    }
    let course = source.parent().and_then(Path::file_name).and_then(|n| n.to_str()).ok_or("Not a course file")?;
    let file = source.file_name().and_then(|n| n.to_str()).ok_or("Not a course file")?;
    let target = cache_path(course, file).ok_or("Open the Study tab first")?;
    let work = std::env::temp_dir().join(format!("bridgedeck-slides-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = convert(source, &work).and_then(|made| {
        fs::create_dir_all(target.parent().ok_or("No folder")?).map_err(|e| e.to_string())?;
        fs::copy(&made, &target).map_err(|e| format!("Couldn't keep the slides' PDF: {e}"))?;
        Ok(target)
    });
    let _ = fs::remove_dir_all(&work);
    result
}

/// Tries the converters this computer has, best first. Returns the PDF written inside `work`.
fn convert(source: &Path, work: &Path) -> Result<PathBuf, String> {
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let mut failures = Vec::new();
    for converter in converters(&ext) {
        match converter.run(source, work) {
            Ok(pdf) if pdf.is_file() && fs::metadata(&pdf).map(|m| m.len() > 0).unwrap_or(false) => return Ok(pdf),
            Ok(_) => failures.push(format!("{} made no PDF", converter.name())),
            Err(e) => failures.push(format!("{}: {e}", converter.name())),
        }
    }
    if failures.is_empty() {
        return Err(no_converter_message(&ext));
    }
    Err(format!("Couldn't turn the slides into pages ({}). You can still open them in your presentation app.", failures.join("; ")))
}

fn no_converter_message(ext: &str) -> String {
    let apps = if cfg!(target_os = "macos") {
        if ext == "odp" { "LibreOffice" } else { "Keynote (free from the App Store) or LibreOffice" }
    } else if cfg!(target_os = "windows") {
        "PowerPoint or LibreOffice"
    } else {
        "LibreOffice"
    };
    format!("To show slides here, BridgeDeck turns them into pages with {apps}, and it isn't installed. Install it (LibreOffice is free at libreoffice.org), or open the slides in your presentation app.")
}

enum Converter {
    LibreOffice(PathBuf),
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Keynote,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    PowerPoint,
}

impl Converter {
    fn name(&self) -> &'static str {
        match self {
            Converter::LibreOffice(_) => "LibreOffice",
            Converter::Keynote => "Keynote",
            Converter::PowerPoint => "PowerPoint",
        }
    }

    fn run(&self, source: &Path, work: &Path) -> Result<PathBuf, String> {
        match self {
            Converter::LibreOffice(soffice) => {
                // Its own profile, so a LibreOffice the user has open doesn't swallow the request. It is
                // kept between conversions: LibreOffice sets a new profile up on its first start, and on
                // a Mac (no wrapper script to restart it) that start exits with code 81 and converts
                // nothing. So a run that made no PDF is tried once more.
                let profile = profile_dir().unwrap_or_else(|| work.join("profile"));
                let stem = source.file_stem().ok_or("No file name")?.to_string_lossy().to_string();
                let pdf = work.join(format!("{stem}.pdf"));
                let mut last = Ok(());
                for _ in 0..2 {
                    let mut cmd = command(soffice);
                    cmd.arg(format!("-env:UserInstallation={}", file_url(&profile)))
                        .args(["--headless", "--norestore", "--nolockcheck", "--convert-to", "pdf", "--outdir"])
                        .arg(work)
                        .arg(source);
                    last = run(cmd);
                    if pdf.is_file() {
                        return Ok(pdf);
                    }
                }
                last.map(|_| pdf)
            }
            Converter::Keynote => {
                let out = work.join("slides.pdf");
                let mut cmd = command(Path::new("/usr/bin/osascript"));
                cmd.args(["-e", KEYNOTE_SCRIPT]).arg(source).arg(&out);
                run(cmd)?;
                Ok(out)
            }
            Converter::PowerPoint => {
                let out = work.join("slides.pdf");
                // The paths go in through the environment, never into the script's text.
                let mut cmd = command(Path::new("powershell.exe"));
                cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERPOINT_SCRIPT])
                    .env("BD_SLIDES_IN", source)
                    .env("BD_SLIDES_OUT", &out);
                run(cmd)?;
                Ok(out)
            }
        }
    }
}

/// Opens the presentation in Keynote, exports it as a PDF and closes it; Keynote is quit again if
/// it wasn't already open.
const KEYNOTE_SCRIPT: &str = r#"on run argv
  set wasRunning to application "Keynote" is running
  set src to POSIX file (item 1 of argv)
  set out to POSIX file (item 2 of argv)
  tell application "Keynote"
    set doc to open src
    export doc to out as PDF
    close doc saving no
  end tell
  if not wasRunning then tell application "Keynote" to quit
end run"#;

/// Saves the presentation as a PDF (format 32) through PowerPoint, without showing it.
const POWERPOINT_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject PowerPoint.Application
$deck = $app.Presentations.Open($env:BD_SLIDES_IN, $true, $false, $false)
try { $deck.SaveAs($env:BD_SLIDES_OUT, 32) } finally { $deck.Close() }
if ($app.Presentations.Count -eq 0) { $app.Quit() }"#;

fn converters(ext: &str) -> Vec<Converter> {
    let mut list = Vec::new();
    #[cfg(target_os = "macos")]
    if ext != "odp" && Path::new("/Applications/Keynote.app").exists() {
        list.push(Converter::Keynote);
    }
    #[cfg(target_os = "windows")]
    if ext != "key" && ext != "odp" && powerpoint_installed() {
        list.push(Converter::PowerPoint);
    }
    let _ = ext;
    if let Some(soffice) = libreoffice() {
        list.push(Converter::LibreOffice(soffice));
    }
    list
}

#[cfg(target_os = "windows")]
fn powerpoint_installed() -> bool {
    // PowerPoint registers its automation class here when it's installed.
    command(Path::new("reg.exe")).args(["query", r"HKCR\PowerPoint.Application"]).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

fn libreoffice() -> Option<PathBuf> {
    let fixed: &[&str] = if cfg!(target_os = "macos") {
        &["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
    } else if cfg!(target_os = "windows") {
        &[r"C:\Program Files\LibreOffice\program\soffice.exe", r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"]
    } else {
        &["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/local/bin/soffice", "/snap/bin/libreoffice", "/opt/libreoffice/program/soffice"]
    };
    fixed.iter().map(PathBuf::from).find(|p| p.is_file())
}

fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    command
}

/// Runs a converter, stopping it if it takes longer than `TIMEOUT`.
fn run(mut cmd: Command) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            let mut err = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                use std::io::Read;
                let _ = stderr.read_to_string(&mut err);
            }
            let err = err.trim();
            return Err(if err.is_empty() { format!("stopped ({status})") } else { err.chars().take(300).collect() });
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("took too long".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let encoded: String = text
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "/-_.~:".contains(c) { c.to_string() } else { c.to_string().bytes().map(|b| format!("%{b:02X}")).collect() })
        .collect();
    if encoded.starts_with('/') { format!("file://{encoded}") } else { format!("file:///{encoded}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tests that point the cache folder somewhere run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn a_kept_pdf_is_used_only_while_it_is_newer_than_the_presentation() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let base = std::env::temp_dir().join(format!("bd-slides-test-{}", uuid::Uuid::new_v4()));
        let course = base.join("library").join("EE 201");
        fs::create_dir_all(&course).unwrap();
        init(&base.join("data"));
        let deck = course.join("Week 1.pptx");
        fs::write(&deck, b"deck").unwrap();
        assert_eq!(cached(&deck), None);

        std::thread::sleep(Duration::from_millis(20));
        let pdf = cache_path("EE 201", "Week 1.pptx").unwrap();
        fs::create_dir_all(pdf.parent().unwrap()).unwrap();
        fs::write(&pdf, b"%PDF").unwrap();
        assert_eq!(cached(&deck), Some(pdf.clone()));

        std::thread::sleep(Duration::from_millis(20));
        fs::write(&deck, b"deck, edited").unwrap();
        assert_eq!(cached(&deck), None, "an edited presentation is converted again");

        forget("EE 201", "Week 1.pptx");
        assert!(!pdf.exists());
        let _ = fs::remove_dir_all(base);
    }

    /// Converts a real presentation end to end. Needs a converter on this computer, so it runs only
    /// when BD_TEST_SLIDES names a presentation: `BD_TEST_SLIDES=deck.pptx cargo test study_slides`.
    #[test]
    fn converts_a_real_presentation_when_one_is_given() {
        let Some(sample) = std::env::var_os("BD_TEST_SLIDES").map(PathBuf::from) else { return };
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let base = std::env::temp_dir().join(format!("bd-slides-real-{}", uuid::Uuid::new_v4()));
        let course = base.join("library").join("Physics");
        fs::create_dir_all(&course).unwrap();
        let deck = course.join(sample.file_name().unwrap());
        fs::copy(&sample, &deck).unwrap();
        init(&base.join("data"));
        let pdf = ensure_pdf(&deck).expect("converted");
        assert!(fs::read(&pdf).unwrap().starts_with(b"%PDF"));
        assert_eq!(cached(&deck), Some(pdf.clone()), "kept for next time");
        assert_eq!(ensure_pdf(&deck).unwrap(), pdf, "not converted twice");
        let _ = fs::remove_dir_all(base);
    }

    /// A stand-in for LibreOffice on a Mac: its first start only sets up the profile and exits with
    /// code 81; the next one converts.
    #[cfg(unix)]
    #[test]
    fn libreoffice_is_run_again_when_its_first_start_converts_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("bd-slides-81-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let fake = base.join("soffice");
        let marker = base.join("profile-made");
        fs::write(&fake, format!("#!/bin/sh\nif [ ! -e '{m}' ]; then touch '{m}'; exit 81; fi\nfor last; do :; done\nwhile [ \"$1\" != --outdir ]; do shift; done\nname=$(basename \"$last\"); printf '%%PDF' > \"$2/${{name%.*}}.pdf\"\n", m = marker.display())).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let deck = base.join("Lecture 3.2.pptx");
        fs::write(&deck, b"deck").unwrap();
        let work = base.join("work");
        fs::create_dir_all(&work).unwrap();
        let pdf = Converter::LibreOffice(fake).run(&deck, &work).expect("second start converts");
        assert_eq!(pdf, work.join("Lecture 3.2.pdf"), "a dot in the name stays");
        assert!(fs::read(&pdf).unwrap().starts_with(b"%PDF"));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn libreoffice_profile_paths_become_file_urls() {
        assert_eq!(file_url(Path::new("/tmp/a b/profile")), "file:///tmp/a%20b/profile");
        assert_eq!(file_url(Path::new(r"C:\Users\x\profile")), "file:///C:/Users/x/profile");
    }

    #[test]
    fn says_what_to_install_when_nothing_can_convert() {
        assert!(no_converter_message("pptx").contains("LibreOffice"));
    }
}
