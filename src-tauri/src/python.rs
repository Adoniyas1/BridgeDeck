//! Python cells in notes: the code runs in this computer's own Python 3 (from python.org, the
//! Microsoft Store or Xcode's tools), with a time limit. Charts drawn with matplotlib come back as
//! pictures. Code only runs when the person presses Run.

use base64::Engine;
use serde::Serialize;
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

const TIME_LIMIT: Duration = Duration::from_secs(30);
const MAX_OUTPUT: usize = 200 * 1024;
const MAX_IMAGES: usize = 6;
const MAX_IMAGE_BYTES: u64 = 3 * 1024 * 1024;
const MAX_CODE: usize = 200 * 1024;

/// Runs the cell's file, prints errors without this wrapper's own frame, and saves matplotlib
/// figures (a non-interactive backend, so nothing opens a window).
const WRAPPER: &str = r#"
import os, sys, traceback, warnings
os.environ.setdefault("MPLBACKEND", "Agg")
warnings.filterwarnings("ignore", message=".*non-interactive.*")
code_path, out_dir = sys.argv[1], sys.argv[2]
sys.argv = ["cell"]
status = 0
try:
    with open(code_path, encoding="utf-8") as f:
        source = f.read()
    exec(compile(source, "cell", "exec"), {"__name__": "__main__"})
except SystemExit as e:
    status = e.code if isinstance(e.code, int) else 0
except BaseException as e:
    traceback.print_exception(type(e), e, e.__traceback__.tb_next)
    status = 1
finally:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        for i, n in enumerate(plt.get_fignums()[:6]):
            plt.figure(n).savefig(os.path.join(out_dir, "figure%d.png" % i), dpi=110, bbox_inches="tight")
    sys.stdout.flush()
    sys.stderr.flush()
os._exit(status)
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonRun {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// PNG pictures as base64.
    pub images: Vec<String>,
    pub ms: u64,
    pub timed_out: bool,
    pub version: String,
}

/// The command that starts Python 3 here, and its version, once found.
static FOUND: Mutex<Option<(Vec<String>, String)>> = Mutex::new(None);

fn command(program: &[String]) -> Command {
    let mut command = Command::new(&program[0]);
    command.args(&program[1..]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn candidates() -> Vec<Vec<String>> {
    let list: &[&[&str]] = if cfg!(windows) {
        &[&["py", "-3"], &["python"], &["python3"]]
    } else {
        &[&["python3"], &["/opt/homebrew/bin/python3"], &["/usr/local/bin/python3"], &["/usr/bin/python3"], &["python"]]
    };
    list.iter().map(|c| c.iter().map(|s| s.to_string()).collect()).collect()
}

/// Python 3 on this computer: the first candidate that answers `--version` with "Python 3.…".
/// (Windows' "python" placeholder that opens the Store fails this.)
pub fn find() -> Option<(Vec<String>, String)> {
    if let Some(found) = FOUND.lock().ok().and_then(|f| f.clone()) {
        return Some(found);
    }
    for program in candidates() {
        let Ok(out) = command(&program).arg("--version").stdin(Stdio::null()).output() else { continue };
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let text = text.trim();
        if out.status.success() && text.starts_with("Python 3") {
            let found = (program, text.to_string());
            if let Ok(mut f) = FOUND.lock() {
                *f = Some(found.clone());
            }
            return Some(found);
        }
    }
    None
}

fn read_capped(mut from: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut from).take(MAX_OUTPUT as u64 + 1).read_to_end(&mut bytes);
        // Keep reading (and dropping) so the program never blocks on a full pipe.
        let _ = std::io::copy(&mut from, &mut std::io::sink());
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if text.len() > MAX_OUTPUT {
            let mut cut = MAX_OUTPUT;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str("\n… (output cut off)");
        }
        text
    })
}

fn images(dir: &Path) -> Vec<String> {
    (0..MAX_IMAGES)
        .map(|i| dir.join(format!("figure{i}.png")))
        .take_while(|p| p.exists())
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.len() <= MAX_IMAGE_BYTES))
        .filter_map(|p| std::fs::read(p).ok())
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        .collect()
}

fn run(code: &str) -> Result<PythonRun, String> {
    if code.len() > MAX_CODE {
        return Err("That cell is too long to run".into());
    }
    let (program, version) = find().ok_or_else(|| {
        if cfg!(windows) { "Python isn’t installed. Get Python 3 from python.org (tick “Add python.exe to PATH”) or the Microsoft Store, then press Run again." }
        else { "Python 3 isn’t installed. Install it from python.org, or run “xcode-select --install” in Terminal, then press Run again." }.to_string()
    })?;
    let dir = std::env::temp_dir().join(format!("bridgedeck-python-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let cell = dir.join("cell.py");
        let wrapper = dir.join("run.py");
        std::fs::write(&cell, code).map_err(|e| e.to_string())?;
        std::fs::write(&wrapper, WRAPPER).map_err(|e| e.to_string())?;
        let started = Instant::now();
        let mut child = command(&program)
            .arg("-u")
            .arg(&wrapper)
            .arg(&cell)
            .arg(&dir)
            .current_dir(&dir)
            .env("PYTHONIOENCODING", "utf-8")
            .env("MPLBACKEND", "Agg")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Couldn’t start Python: {e}"))?;
        let stdout = read_capped(child.stdout.take().expect("piped"));
        let stderr = read_capped(child.stderr.take().expect("piped"));
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break Some(status);
            }
            if started.elapsed() > TIME_LIMIT {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        let mut stderr = stderr.join().unwrap_or_default();
        if timed_out {
            stderr.push_str(&format!("\nStopped after {} seconds.", TIME_LIMIT.as_secs()));
        }
        Ok(PythonRun {
            ok: status.is_some_and(|s| s.success()),
            stdout: stdout.join().unwrap_or_default(),
            stderr,
            images: images(&dir),
            ms: started.elapsed().as_millis() as u64,
            timed_out,
            version: version.clone(),
        })
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// Python's version here, if it's installed.
#[tauri::command]
pub async fn python_status() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| find().map(|(_, v)| v)).await.ok().flatten()
}

#[tauri::command]
pub async fn python_run(code: String) -> Result<PythonRun, String> {
    tauri::async_runtime::spawn_blocking(move || run(&code)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_a_cell_with_output_errors_and_a_time_limit() {
        if find().is_none() {
            return; // no Python on this machine
        }
        let out = run("print(2 ** 10)\nimport sys\nprint('warn', file=sys.stderr)").unwrap();
        assert!(out.ok);
        assert_eq!(out.stdout.trim(), "1024");
        assert_eq!(out.stderr.trim(), "warn");
        let bad = run("x = 1\n1 / 0").unwrap();
        assert!(!bad.ok);
        assert!(bad.stderr.contains("ZeroDivisionError"), "{}", bad.stderr);
        assert!(bad.stderr.contains("File \"cell\", line 2"), "{}", bad.stderr);
        assert!(!bad.stderr.contains("run.py"), "{}", bad.stderr);
        let exit = run("import sys\nprint('bye')\nsys.exit(0)").unwrap();
        assert!(exit.ok && exit.stdout.contains("bye"));
    }
}
