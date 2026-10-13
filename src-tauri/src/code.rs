//! The Code tab: write a program, press Run, and it's compiled and run by the compilers already on
//! this computer (Xcode's command line tools on a Mac, or whatever is installed: Python, Node, Java,
//! Rust, Go, Icarus Verilog…), with what's typed in the input box as its input and a time limit.
//! Programs are kept in the shared folder, `<shared>/Code/<name>.<ext>`, so they're on both computers.
//! Code only runs when the person presses Run.

use serde::Serialize;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::AppHandle;

const MAX_CODE: usize = 512 * 1024;
const MAX_INPUT: usize = 1024 * 1024;
const COMPILE_LIMIT: Duration = Duration::from_secs(90);
const MAX_RUN_LIMIT: u64 = 120;

/// One language: the file the code goes in, how it's built (if it is) and how it's run.
struct Lang {
    id: &'static str,
    name: &'static str,
    ext: &'static str,
    /// Programs that can build or run it, first found wins.
    tools: &'static [&'static str],
    /// A second program it needs (Java's `java` after `javac`, Verilog's `vvp` after `iverilog`).
    runner: Option<&'static [&'static str]>,
    install_mac: &'static str,
    install_windows: &'static str,
    install_linux: &'static str,
}

const LANGS: &[Lang] = &[
    Lang { id: "c", name: "C", ext: "c", tools: &["cc", "clang", "gcc"], runner: None, install_mac: "Run “xcode-select --install” in Terminal.", install_windows: "Install MSYS2 (msys2.org) and its gcc, or Visual Studio’s clang.", install_linux: "Install gcc (sudo apt install build-essential)." },
    Lang { id: "cpp", name: "C++", ext: "cpp", tools: &["c++", "clang++", "g++"], runner: None, install_mac: "Run “xcode-select --install” in Terminal.", install_windows: "Install MSYS2 (msys2.org) and its g++, or Visual Studio’s clang.", install_linux: "Install g++ (sudo apt install build-essential)." },
    Lang { id: "python", name: "Python", ext: "py", tools: &[], runner: None, install_mac: "Install Python 3 from python.org, or run “xcode-select --install”.", install_windows: "Install Python 3 from python.org (tick “Add python.exe to PATH”) or the Microsoft Store.", install_linux: "Install python3." },
    Lang { id: "matlab", name: "MATLAB", ext: "m", tools: &["matlab", "octave-cli", "octave"], runner: None, install_mac: "Install MATLAB (your school’s licence), or the free GNU Octave, which runs most MATLAB code (“brew install octave”, or octave.org).", install_windows: "Install MATLAB (your school’s licence), or the free GNU Octave from octave.org, which runs most MATLAB code.", install_linux: "Install MATLAB, or GNU Octave (sudo apt install octave), which runs most MATLAB code." },
    Lang { id: "java", name: "Java", ext: "java", tools: &["javac"], runner: Some(&["java"]), install_mac: "Install a JDK (adoptium.net, or “brew install openjdk”).", install_windows: "Install a JDK from adoptium.net.", install_linux: "Install a JDK (sudo apt install default-jdk)." },
    Lang { id: "javascript", name: "JavaScript", ext: "js", tools: &["node"], runner: None, install_mac: "Install Node.js from nodejs.org (or “brew install node”).", install_windows: "Install Node.js from nodejs.org.", install_linux: "Install Node.js from nodejs.org." },
    Lang { id: "rust", name: "Rust", ext: "rs", tools: &["rustc"], runner: None, install_mac: "Install Rust from rustup.rs.", install_windows: "Install Rust from rustup.rs.", install_linux: "Install Rust from rustup.rs." },
    Lang { id: "go", name: "Go", ext: "go", tools: &["go"], runner: None, install_mac: "Install Go from go.dev (or “brew install go”).", install_windows: "Install Go from go.dev.", install_linux: "Install Go from go.dev." },
    Lang { id: "verilog", name: "Verilog", ext: "v", tools: &["iverilog"], runner: Some(&["vvp"]), install_mac: "Install Icarus Verilog (“brew install icarus-verilog”).", install_windows: "Install Icarus Verilog from bleyer.org/icarus.", install_linux: "Install Icarus Verilog (sudo apt install iverilog)." },
    Lang { id: "bash", name: "Shell (bash)", ext: "sh", tools: &["bash"], runner: None, install_mac: "bash comes with macOS.", install_windows: "Install Git for Windows (it includes bash).", install_linux: "bash comes with Linux." },
];

fn lang(id: &str) -> Option<&'static Lang> {
    LANGS.iter().find(|l| l.id == id)
}

/// Where programs are looked for: the usual places as well as PATH, since an app opened from the
/// Dock or Finder gets only a short PATH.
fn search_path() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if !cfg!(windows) {
        for d in ["/opt/homebrew/bin", "/opt/homebrew/opt/openjdk/bin", "/usr/local/bin", "/usr/local/go/bin", "/opt/local/bin"] {
            dirs.push(PathBuf::from(d));
        }
    }
    if let Some(home) = &home {
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join("go").join("bin"));
    }
    if cfg!(windows) {
        for d in ["C:\\msys64\\ucrt64\\bin", "C:\\msys64\\mingw64\\bin", "C:\\Program Files\\Git\\bin", "C:\\Program Files\\nodejs", "C:\\Program Files\\Go\\bin", "C:\\iverilog\\bin"] {
            dirs.push(PathBuf::from(d));
        }
    }
    // MATLAB installs into a folder of its own, one per release (newest first).
    let mut matlab: Vec<PathBuf> = Vec::new();
    let roots: &[&str] = if cfg!(target_os = "macos") { &["/Applications"] } else if cfg!(windows) { &["C:\\Program Files\\MATLAB"] } else { &["/usr/local/MATLAB", "/opt/MATLAB"] };
    for root in roots {
        for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("MATLAB") || name.starts_with('R') {
                matlab.push(entry.path().join("bin"));
            }
        }
    }
    matlab.sort();
    dirs.extend(matlab.into_iter().rev());
    // Octave from its installer: /Applications/Octave-x.y.app on a Mac, C:\Program Files\GNU Octave on Windows.
    if cfg!(target_os = "macos") {
        for entry in std::fs::read_dir("/Applications").into_iter().flatten().flatten() {
            if entry.file_name().to_string_lossy().starts_with("Octave") {
                dirs.push(entry.path().join("Contents/Resources/usr/bin"));
            }
        }
    }
    if cfg!(windows) {
        for entry in std::fs::read_dir("C:\\Program Files\\GNU Octave").into_iter().flatten().flatten() {
            dirs.push(entry.path().join("mingw64").join("bin"));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// macOS keeps stand-ins for the developer tools in /usr/bin that pop up an "install the command
/// line tools" window when run; they're only real once the tools are installed.
fn developer_tools_installed() -> bool {
    !cfg!(target_os = "macos") || Command::new("/usr/bin/xcode-select").arg("-p").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

/// Same for Java: /usr/bin/java is a stand-in until a JDK is installed.
fn java_installed() -> bool {
    !cfg!(target_os = "macos") || Command::new("/usr/libexec/java_home").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

fn which(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) { vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()] } else { vec![name.to_string()] };
    for dir in search_path() {
        for n in &names {
            let p = dir.join(n);
            if !p.is_file() {
                continue;
            }
            let in_usr_bin = p.starts_with("/usr/bin");
            if cfg!(target_os = "macos") && in_usr_bin {
                let java = matches!(name, "java" | "javac");
                if (java && !java_installed()) || (!java && name != "bash" && !developer_tools_installed()) {
                    continue;
                }
            }
            return Some(p);
        }
    }
    None
}

/// The programs found for a language (and the runner after it, if it needs one), cached.
type Found = Vec<(String, Option<Vec<String>>)>;
static FOUND: Mutex<Option<Found>> = Mutex::new(None);

fn tools_for(l: &Lang) -> Option<Vec<String>> {
    if l.id == "python" {
        return crate::python::find().map(|(program, _)| program);
    }
    let first = l.tools.iter().find_map(|t| which(t))?;
    let mut found = vec![first.to_string_lossy().into_owned()];
    if let Some(runner) = l.runner {
        found.push(runner.iter().find_map(|t| which(t))?.to_string_lossy().into_owned());
    }
    Some(found)
}

fn found(l: &Lang) -> Option<Vec<String>> {
    if let Ok(cache) = FOUND.lock() {
        if let Some(hit) = cache.as_ref().and_then(|c| c.iter().find(|(id, _)| id == l.id)) {
            return hit.1.clone();
        }
    }
    let tools = tools_for(l);
    if let Ok(mut cache) = FOUND.lock() {
        cache.get_or_insert_with(Vec::new).push((l.id.to_string(), tools.clone()));
    }
    tools
}

fn version_of(program: &str, l: &Lang) -> String {
    if l.id == "matlab" && is_matlab(program) {
        // Starting MATLAB just to ask its version takes a while: its folder says (…/MATLAB_R2024b.app/bin).
        return Path::new(program).ancestors().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).find(|n| n.contains('R') && n.chars().any(|c| c.is_ascii_digit())).map(|n| format!("MATLAB {}", n.trim_start_matches("MATLAB_").trim_end_matches(".app"))).unwrap_or_else(|| "MATLAB".into());
    }
    let flag = match l.id { "go" => "version", "verilog" => "-V", "java" => "-version", _ => "--version" };
    let out = Command::new(program).arg(flag).env("PATH", joined_path()).stdin(Stdio::null()).output();
    let Ok(out) = out else { return String::new() };
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("").chars().take(80).collect()
}

fn joined_path() -> std::ffi::OsString {
    std::env::join_paths(search_path()).unwrap_or_default()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Language {
    pub id: String,
    pub name: String,
    pub ext: String,
    pub available: bool,
    pub version: String,
    /// How to install it here, when it isn't.
    pub install: String,
}

fn languages() -> Vec<Language> {
    LANGS
        .iter()
        .map(|l| {
            let tools = found(l);
            Language {
                id: l.id.into(),
                name: l.name.into(),
                ext: l.ext.into(),
                available: tools.is_some(),
                version: tools.as_ref().map(|t| version_of(&t[0], l)).unwrap_or_default(),
                install: if cfg!(target_os = "macos") { l.install_mac } else if cfg!(windows) { l.install_windows } else { l.install_linux }.into(),
            }
        })
        .collect()
}

/// The languages and whether each can run here (checked again when asked to, after installing one).
#[tauri::command]
pub async fn code_languages(refresh: Option<bool>) -> Vec<Language> {
    if refresh.unwrap_or(false) {
        if let Ok(mut cache) = FOUND.lock() {
            *cache = None;
        }
    }
    tauri::async_runtime::spawn_blocking(languages).await.unwrap_or_default()
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub ms: u64,
    pub timed_out: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodeRun {
    /// Building it (compiled languages only).
    pub compile: Option<Step>,
    /// Running it (not when it didn't build).
    pub run: Option<Step>,
    /// The file the code was in, as error messages name it.
    pub file: String,
}

/// Runs a program in `dir` with `input` on its standard input, stopping it after `limit`.
fn step(program: &[String], dir: &Path, input: &str, limit: Duration) -> Result<Step, String> {
    let started = Instant::now();
    let mut command: Command = crate::python::command(program);
    let mut child = command
        .current_dir(dir)
        .env("PATH", joined_path())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .env("GOCACHE", dir.join(".gocache"))
        .env("GOFLAGS", "-mod=mod")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn’t start {}: {e}", program[0]))?;
    // Input on its own thread: a program that doesn't read it mustn't hold this one up.
    let mut stdin = child.stdin.take().expect("piped");
    let input = input.to_string();
    let feeder = std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let stdout = crate::python::read_capped(child.stdout.take().expect("piped"));
    let stderr = crate::python::read_capped(child.stderr.take().expect("piped"));
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(status);
        }
        if started.elapsed() > limit {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let _ = feeder.join();
    let mut stderr = stderr.join().unwrap_or_default();
    if timed_out {
        stderr.push_str(&format!("\nStopped after {} seconds (the time limit). Waiting for input? Type it in the Input box before pressing Run.", limit.as_secs()));
    }
    Ok(Step { ok: status.is_some_and(|s| s.success()), stdout: stdout.join().unwrap_or_default(), stderr, exit_code: status.and_then(|s| s.code()), ms: started.elapsed().as_millis() as u64, timed_out })
}

/// Java wants the file named after its public class.
fn java_class(source: &str) -> String {
    let words: Vec<&str> = source.split(|c: char| c.is_whitespace() || c == '{').filter(|w| !w.is_empty()).collect();
    for (i, w) in words.iter().enumerate() {
        if *w != "public" {
            continue;
        }
        let mut j = i + 1;
        while matches!(words.get(j), Some(&"final") | Some(&"abstract")) {
            j += 1;
        }
        if words.get(j) == Some(&"class") {
            if let Some(name) = words.get(j + 1) {
                let name: String = name.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                if name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_') {
                    return name;
                }
            }
        }
    }
    "Main".into()
}

fn run(language: &str, source: &str, input: &str, limit_secs: u64) -> Result<CodeRun, String> {
    let l = lang(language).ok_or("That language isn’t one BridgeDeck knows")?;
    if source.len() > MAX_CODE {
        return Err("That program is too long to run here".into());
    }
    if input.len() > MAX_INPUT {
        return Err("That input is too long".into());
    }
    let tools = found(l).ok_or_else(|| format!("{} isn’t installed on this computer. {}", l.name, if cfg!(target_os = "macos") { l.install_mac } else if cfg!(windows) { l.install_windows } else { l.install_linux }))?;
    let limit = Duration::from_secs(limit_secs.clamp(1, MAX_RUN_LIMIT));
    let stamp = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("bridgedeck-code-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let stem = if l.id == "java" { java_class(source) } else { "main".to_string() };
        let file = format!("{stem}.{}", l.ext);
        std::fs::write(dir.join(&file), source).map_err(|e| e.to_string())?;
        let exe = if cfg!(windows) { "main.exe" } else { "./main" };
        let exe_path = dir.join(if cfg!(windows) { "main.exe" } else { "main" }).to_string_lossy().into_owned();
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
        let tool = |i: usize| tools[i].clone();
        let (build, start): (Option<Vec<String>>, Vec<String>) = match l.id {
            "c" => (Some([vec![tool(0)], s(&["-std=c17", "-Wall", "-O1", "-g", "-o", exe, &file, "-lm"])].concat()), vec![exe_path]),
            "cpp" => (Some([vec![tool(0)], s(&["-std=c++17", "-Wall", "-O1", "-g", "-o", exe, &file])].concat()), vec![exe_path]),
            "rust" => (Some([vec![tool(0)], s(&["--edition", "2021", "-O", "-o", exe, &file])].concat()), vec![exe_path]),
            "go" => (Some([vec![tool(0)], s(&["build", "-o", exe, &file])].concat()), vec![exe_path]),
            "java" => (Some([vec![tool(0)], s(&["-encoding", "UTF-8", &file])].concat()), vec![tool(1), "-cp".into(), ".".into(), stem.clone()]),
            "verilog" => (Some([vec![tool(0)], s(&["-g2012", "-o", "main.vvp", &file])].concat()), vec![tool(1), "-n".into(), "main.vvp".into()]),
            "python" => (None, [tools.clone(), s(&["-u", &file])].concat()),
            // MATLAB itself runs the script in batch mode; Octave runs the file, without a window.
            "matlab" if is_matlab(&tool(0)) => (None, vec![tool(0), "-batch".into(), stem.clone()]),
            "matlab" => (None, [vec![tool(0)], s(&["--no-gui", "--quiet", "--no-window-system", "--no-init-file", &file])].concat()),
            _ => (None, vec![tool(0), file.clone()]),
        };
        let mut out = CodeRun { file: file.clone(), ..Default::default() };
        if let Some(build) = build {
            let compiled = step(&build, &dir, "", COMPILE_LIMIT)?;
            let ok = compiled.ok;
            out.compile = Some(compiled);
            if !ok {
                return Ok(out);
            }
        }
        out.run = Some(step(&start, &dir, input, limit)?);
        Ok(out)
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// MATLAB (not Octave): its program is called matlab.
fn is_matlab(program: &str) -> bool {
    Path::new(program).file_stem().is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("matlab"))
}

#[tauri::command]
pub async fn code_run(language: String, source: String, input: String, limit_secs: u64) -> Result<CodeRun, String> {
    tauri::async_runtime::spawn_blocking(move || run(&language, &source, &input, limit_secs)).await.map_err(|e| e.to_string())?
}

// ---- Saved programs ----

fn folder(app: &AppHandle) -> PathBuf {
    crate::circuits::shared(app).join("Code")
}

/// A saved program's file: a usable name and one of the languages' extensions.
fn file(app: &AppHandle, name: &str, ext: &str) -> Result<PathBuf, String> {
    if !crate::circuits::valid_name(name) {
        return Err("That name can't be used for a file (no / \\ : * ? \" < > |)".into());
    }
    if !LANGS.iter().any(|l| l.ext == ext) {
        return Err("Not a kind of program BridgeDeck runs".into());
    }
    Ok(folder(app).join(format!("{}.{ext}", name.trim())))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFile {
    pub name: String,
    pub language: String,
    pub modified: u64,
}

#[tauri::command]
pub fn code_files(app: AppHandle) -> Vec<CodeFile> {
    let mut out: Vec<CodeFile> = std::fs::read_dir(folder(&app))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path.extension()?.to_str()?;
            let l = LANGS.iter().find(|l| l.ext == ext)?;
            let name = path.file_stem()?.to_str()?.to_string();
            if name.starts_with('.') {
                return None;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            Some(CodeFile { name, language: l.id.into(), modified })
        })
        .collect();
    out.sort_by_key(|f| std::cmp::Reverse(f.modified));
    out
}

#[tauri::command]
pub fn code_load(app: AppHandle, name: String, language: String) -> Result<String, String> {
    let l = lang(&language).ok_or("Unknown language")?;
    std::fs::read_to_string(file(&app, &name, l.ext)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn code_save(app: AppHandle, name: String, language: String, source: String) -> Result<(), String> {
    let l = lang(&language).ok_or("Unknown language")?;
    if source.len() > MAX_CODE {
        return Err("That program is too long to save".into());
    }
    let path = file(&app, &name, l.ext)?;
    std::fs::create_dir_all(folder(&app)).map_err(|e| e.to_string())?;
    std::fs::write(path, source).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn code_delete(app: AppHandle, name: String, language: String) -> Result<(), String> {
    let l = lang(&language).ok_or("Unknown language")?;
    std::fs::remove_file(file(&app, &name, l.ext)?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has(id: &str) -> bool {
        lang(id).and_then(found).is_some()
    }

    #[test]
    fn compiles_and_runs_c_with_input_and_reports_errors() {
        if !has("c") {
            return;
        }
        let ok = run("c", "#include <stdio.h>\nint main(void){int a,b;scanf(\"%d %d\",&a,&b);printf(\"%d\\n\",a+b);return 0;}", "2 40", 10).unwrap();
        assert!(ok.compile.as_ref().unwrap().ok);
        assert_eq!(ok.run.as_ref().unwrap().stdout.trim(), "42");
        let bad = run("c", "int main(void){ return x; }", "", 10).unwrap();
        assert!(!bad.compile.as_ref().unwrap().ok);
        assert!(bad.run.is_none());
        assert!(bad.compile.unwrap().stderr.contains("main.c:1"));
    }

    #[test]
    fn stops_a_program_that_runs_too_long() {
        if !has("python") {
            return;
        }
        let out = run("python", "while True: pass", "", 1).unwrap();
        let r = out.run.unwrap();
        assert!(r.timed_out && !r.ok);
    }

    #[test]
    fn names_java_files_after_their_class_and_runs_other_languages() {
        if has("java") {
            let out = run("java", "public class Hello { public static void main(String[] a) { System.out.println(new java.util.Scanner(System.in).nextLine().toUpperCase()); } }", "hi", 20).unwrap();
            assert_eq!(out.file, "Hello.java");
            assert_eq!(out.run.unwrap().stdout.trim(), "HI");
        }
        if has("cpp") {
            let out = run("cpp", "#include <iostream>\nint main(){std::string s; std::getline(std::cin,s); std::cout<<s.size()<<'\\n';}", "hello", 10).unwrap();
            assert_eq!(out.run.unwrap().stdout.trim(), "5");
        }
        if has("rust") {
            let out = run("rust", "fn main(){ let mut s=String::new(); std::io::stdin().read_line(&mut s).unwrap(); println!(\"{}\", s.trim().len()); }", "abc", 10).unwrap();
            assert_eq!(out.run.unwrap().stdout.trim(), "3");
        }
        if has("javascript") {
            let out = run("javascript", "console.log(require('fs').readFileSync(0,'utf8').trim().split(' ').map(Number).reduce((a,b)=>a+b))", "1 2 3", 10).unwrap();
            assert_eq!(out.run.unwrap().stdout.trim(), "6");
        }
        if has("python") {
            let out = run("python", "x = int(input())\nprint(x * 2)\n1/0", "21", 10).unwrap();
            let r = out.run.unwrap();
            assert_eq!(r.stdout.trim(), "42");
            assert!(!r.ok && r.stderr.contains("ZeroDivisionError") && r.stderr.contains("main.py"));
        }
        if has("matlab") {
            let out = run("matlab", "x = [1 2; 3 4];\ndisp(sum(x(:)))\nfprintf('%d\\n', size(x, 1));", "", 60).unwrap();
            let r = out.run.unwrap();
            assert!(r.ok, "{}", r.stderr);
            assert_eq!(r.stdout.split_whitespace().collect::<Vec<_>>(), ["10", "2"]);
            let bad = run("matlab", "a = 1;\nb = nope + a;", "", 60).unwrap().run.unwrap();
            assert!(!bad.ok && bad.stderr.contains("line 2"), "{}", bad.stderr);
        }
        assert_eq!(java_class("class A {}\npublic final class Main2 {"), "Main2");
        assert_eq!(java_class("class A {}"), "Main");
    }

    #[test]
    fn refuses_unknown_languages_and_odd_file_names() {
        assert!(run("cobol", "", "", 1).is_err());
        assert!(LANGS.iter().all(|l| !l.ext.contains('.')));
    }
}
