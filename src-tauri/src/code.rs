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
    Lang { id: "matlab", name: "MATLAB", ext: "m", tools: &["matlab", "octave", "octave-cli"], runner: None, install_mac: "Install MATLAB (your school’s licence), or the free GNU Octave, which runs most MATLAB code (“brew install octave”, or octave.org).", install_windows: "Install MATLAB (your school’s licence), or the free GNU Octave from octave.org, which runs most MATLAB code.", install_linux: "Install MATLAB, or GNU Octave (sudo apt install octave), which runs most MATLAB code." },
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
    let out = crate::python::command(&[program.to_string(), flag.to_string()]).env("PATH", joined_path()).stdin(Stdio::null()).output();
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
    /// Pictures it drew (matplotlib, MATLAB/Octave figures), as base64 PNGs.
    pub images: Vec<String>,
    /// MATLAB/Octave: the variables it left, like MATLAB's Workspace panel.
    pub workspace: Vec<Variable>,
}

/// A variable a MATLAB/Octave program left behind.
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub name: String,
    pub size: String,
    pub class: String,
    pub value: String,
}

/// The variables the Octave runner wrote out (workspace.tsv), if it did.
fn workspace(dir: &Path) -> Vec<Variable> {
    std::fs::read_to_string(dir.join("workspace.tsv"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut f = l.splitn(4, '\t');
            Some(Variable { name: f.next()?.into(), size: f.next()?.replace('x', "×"), class: f.next()?.into(), value: f.next().unwrap_or("").into() })
        })
        .take(200)
        .collect()
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

/// Runs a Python program and saves the matplotlib figures it drew (a backend with no window, so
/// plt.show() doesn't wait for one); errors are shown without this wrapper's own frame.
const PY_WRAPPER: &str = r#"
import os, sys, traceback, warnings
os.environ.setdefault("MPLBACKEND", "Agg")
warnings.filterwarnings("ignore", message=".*non-interactive.*")
path, out = sys.argv[1], sys.argv[2]
sys.argv = [path]
status = 0
try:
    with open(path, encoding="utf-8") as f:
        source = f.read()
    exec(compile(source, path, "exec"), {"__name__": "__main__"})
except SystemExit as e:
    status = e.code if isinstance(e.code, int) else 0
except BaseException as e:
    traceback.print_exception(type(e), e, e.__traceback__.tb_next)
    status = 1
finally:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        for i, n in enumerate(plt.get_fignums()[:6]):
            plt.figure(n).savefig(os.path.join(out, "figure%d.png" % i), dpi=110, bbox_inches="tight")
    sys.stdout.flush()
    sys.stderr.flush()
os._exit(status)
"#;

/// Runs the script with figures hidden, then saves each figure it drew as figure0.png….
const OCTAVE_RUNNER: &str = "set(0, 'defaultfigurevisible', 'off');\nbridgedeck_status = 0;\ntry\n  main\ncatch bridgedeck_err\n  fprintf(2, 'error: %s\\n', bridgedeck_err.message);\n  for bridgedeck_k = 1:numel(bridgedeck_err.stack)\n    fprintf(2, '    %s at line %d\\n', bridgedeck_err.stack(bridgedeck_k).name, bridgedeck_err.stack(bridgedeck_k).line);\n  end\n  bridgedeck_status = 1;\nend\nwarning('off', 'all');\nbridgedeck_workspace(who);\nbridgedeck_figs = get(0, 'children');\nfor bridgedeck_i = 1:min(numel(bridgedeck_figs), 6)\n  try\n    print(bridgedeck_figs(bridgedeck_i), sprintf('figure%d.png', bridgedeck_i - 1), '-dpng', '-r110');\n  catch\n  end\nend\nexit(bridgedeck_status);\n";

/// The same for MATLAB, as one -batch command.
const MATLAB_BATCH: &str = "set(0,'DefaultFigureVisible','off'); try, main, catch err, fprintf(2,'%s\\n',err.getReport('basic')); figs=findobj('type','figure'); for i=1:min(numel(figs),6), print(figs(i),sprintf('figure%d.png',i-1),'-dpng','-r110'); end, exit(1), end, figs=findobj('type','figure'); for i=1:min(numel(figs),6), print(figs(i),sprintf('figure%d.png',i-1),'-dpng','-r110'); end";

/// A program written out and ready: the folder, its file, how to build it (if it's built) and how
/// to start it.
struct Prepared {
    dir: PathBuf,
    file: String,
    build: Option<Vec<String>>,
    start: Vec<String>,
}

fn prepare(language: &str, source: &str) -> Result<Prepared, String> {
    let l = lang(language).ok_or("That language isn’t one BridgeDeck knows")?;
    if source.len() > MAX_CODE {
        return Err("That program is too long to run here".into());
    }
    let tools = found(l).ok_or_else(|| format!("{} isn’t installed on this computer. {}", l.name, if cfg!(target_os = "macos") { l.install_mac } else if cfg!(windows) { l.install_windows } else { l.install_linux }))?;
    let stamp = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("bridgedeck-code-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = if l.id == "java" { java_class(source) } else { "main".to_string() };
    let file = format!("{stem}.{}", l.ext);
    let written = (|| -> std::io::Result<()> {
        std::fs::write(dir.join(&file), source)?;
        if l.id == "python" {
            std::fs::write(dir.join("bridgedeck_run.py"), PY_WRAPPER)?;
        }
        if l.id == "matlab" && !is_matlab(&tools[0]) {
            // Octave: MATLAB functions it lacks, and the packages the program needs.
            std::fs::write(dir.join("bridgedeck_run.m"), crate::octave::prelude(source) + OCTAVE_RUNNER)?;
            let compat = dir.join("bridgedeck_compat");
            std::fs::create_dir_all(&compat)?;
            for (name, body) in crate::octave::FILL_INS {
                std::fs::write(compat.join(name), body)?;
            }
        }
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e.to_string());
    }
    let exe = if cfg!(windows) { "main.exe" } else { "./main" };
    let exe_path = dir.join(if cfg!(windows) { "main.exe" } else { "main" }).to_string_lossy().into_owned();
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let tool = |i: usize| tools[i].clone();
    let out_dir = dir.to_string_lossy().into_owned();
    let (build, start): (Option<Vec<String>>, Vec<String>) = match l.id {
        "c" => (Some([vec![tool(0)], s(&["-std=c17", "-Wall", "-O1", "-g", "-o", exe, &file, "-lm"])].concat()), vec![exe_path]),
        "cpp" => (Some([vec![tool(0)], s(&["-std=c++17", "-Wall", "-O1", "-g", "-o", exe, &file])].concat()), vec![exe_path]),
        "rust" => (Some([vec![tool(0)], s(&["--edition", "2021", "-O", "-o", exe, &file])].concat()), vec![exe_path]),
        "go" => (Some([vec![tool(0)], s(&["build", "-o", exe, &file])].concat()), vec![exe_path]),
        "java" => (Some([vec![tool(0)], s(&["-encoding", "UTF-8", &file])].concat()), vec![tool(1), "-cp".into(), ".".into(), stem.clone()]),
        "verilog" => (Some([vec![tool(0)], s(&["-g2012", "-o", "main.vvp", &file])].concat()), vec![tool(1), "-n".into(), "main.vvp".into()]),
        "python" => (None, [tools.clone(), s(&["-u", "bridgedeck_run.py", &file, &out_dir])].concat()),
        // MATLAB itself runs the script in batch mode; Octave runs it through a small runner. Both
        // save the figures it drew (Octave's command-line-only build can't draw, so it has none).
        "matlab" if is_matlab(&tool(0)) => (None, vec![tool(0), "-batch".into(), MATLAB_BATCH.into()]),
        "matlab" if Path::new(&tool(0)).file_stem().is_some_and(|n| n.to_string_lossy().contains("cli")) => (None, [vec![tool(0)], s(&["--no-gui", "--quiet", "--no-window-system", "--no-init-file", "bridgedeck_run.m"])].concat()),
        "matlab" => (None, [vec![tool(0)], s(&["--no-gui", "--quiet", "--no-init-file", "bridgedeck_run.m"])].concat()),
        _ => (None, vec![tool(0), file.clone()]),
    };
    Ok(Prepared { dir, file, build, start })
}

/// The pictures a program drew (figure0.png…), as base64 PNGs.
fn figures(dir: &Path) -> Vec<String> {
    use base64::Engine;
    (0..6)
        .map(|i| dir.join(format!("figure{i}.png")))
        .take_while(|p| p.exists())
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.len() <= 4 * 1024 * 1024))
        .filter_map(|p| std::fs::read(p).ok())
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        .collect()
}

fn run(language: &str, source: &str, input: &str, limit_secs: u64) -> Result<CodeRun, String> {
    if input.len() > MAX_INPUT {
        return Err("That input is too long".into());
    }
    let limit = Duration::from_secs(limit_secs.clamp(1, MAX_RUN_LIMIT));
    let p = prepare(language, source)?;
    let result = (|| {
        let mut out = CodeRun { file: p.file.clone(), ..Default::default() };
        if let Some(build) = &p.build {
            let compiled = step(build, &p.dir, "", COMPILE_LIMIT)?;
            let ok = compiled.ok;
            out.compile = Some(compiled);
            if !ok {
                return Ok(out);
            }
        }
        out.run = Some(step(&p.start, &p.dir, input, limit)?);
        out.images = figures(&p.dir);
        out.workspace = workspace(&p.dir);
        Ok(out)
    })();
    let _ = std::fs::remove_dir_all(&p.dir);
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

/// Installs an Octave package (control, signal, statistics or symbolic) from Octave Forge, so
/// programs using MATLAB's toolbox functions run. Takes a few minutes; needs the internet.
#[tauri::command]
pub async fn code_octave_install(name: String) -> Result<String, String> {
    if !crate::octave::is_package(&name) {
        return Err("That isn’t a package BridgeDeck installs".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let l = lang("matlab").ok_or("No MATLAB language")?;
        let tools = found(l).ok_or("GNU Octave isn’t installed on this computer")?;
        let octave = tools.iter().find(|t| !is_matlab(t)).ok_or("Installing packages needs GNU Octave (MATLAB has its toolboxes built in)")?.clone();
        crate::activity::info("code", &format!("Installing Octave's {name} package."));
        let dir = std::env::temp_dir();
        let command = vec![octave, "--no-gui".into(), "--quiet".into(), "--no-init-file".into(), "--eval".into(), format!("pkg install -forge {name}; pkg load {name}; disp('installed')")];
        let out = step(&command, &dir, "", Duration::from_secs(20 * 60))?;
        let text = format!("{}{}", out.stdout, out.stderr);
        if out.ok && text.contains("installed") {
            crate::activity::info("code", &format!("Installed Octave's {name} package."));
            Ok(format!("Installed the {name} package. Run the program again."))
        } else {
            // Octave's own words, without its call stack or Qt's start-up notes.
            let said: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("QStandardPaths") && !l.contains(" at line ") && !l.starts_with("error: called from")).collect();
            let tail = said[said.len().saturating_sub(4)..].join("\n");
            crate::activity::warn("code", &format!("Installing Octave's {name} package failed: {tail}"));
            let hint = if text.contains("could not read URL") {
                "Octave couldn’t download it: check the internet connection.\n".to_string()
            } else if cfg!(target_os = "linux") {
                format!("On Linux the ready-made one is easier: sudo apt install octave-{name}\n")
            } else if cfg!(target_os = "macos") {
                "Octave needs Xcode’s command line tools to build it: xcode-select --install\n".to_string()
            } else {
                String::new()
            };
            Err(format!("Couldn’t install the {name} package{}.\n{hint}{tail}", if out.timed_out { " (it took too long)" } else { "" }))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Live runs: output as it comes, input as it's typed ----

/// What a live run sends the window, as it happens.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodeEvent {
    pub id: u64,
    /// "compile" (the build's messages and whether it worked), "out", "err", or "exit".
    pub kind: String,
    pub text: String,
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub ms: u64,
    pub timed_out: bool,
    pub file: String,
    pub images: Vec<String>,
    pub workspace: Vec<Variable>,
}

struct Live {
    stdin: Option<std::process::ChildStdin>,
    child: std::sync::Arc<Mutex<Option<std::process::Child>>>,
}

static LIVE: Mutex<Option<std::collections::HashMap<u64, Live>>> = Mutex::new(None);
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// A live run's output stops being passed on past this much (a print loop shouldn't fill memory).
const LIVE_OUTPUT: usize = 2 * 1024 * 1024;

fn live<T>(f: impl FnOnce(&mut std::collections::HashMap<u64, Live>) -> T) -> T {
    let mut guard = LIVE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Default::default))
}

/// Builds the program if it's built, then runs it with its output sent to the window as it comes
/// (`code-event`), the input box's text first on its input, then whatever's typed (code_input).
/// `limit_secs` 0: no time limit (the window's Stop ends it).
fn start_live(app: tauri::AppHandle, id: u64, language: String, source: String, input: String, limit_secs: u64) {
    use std::io::Read;
    use tauri::Emitter;
    let send = move |e: CodeEvent| {
        let _ = app.emit("code-event", CodeEvent { id, ..e });
    };
    let p = match prepare(&language, &source) {
        Ok(p) => p,
        Err(e) => {
            send(CodeEvent { kind: "exit".into(), text: e, ..Default::default() });
            return;
        }
    };
    let file = p.file.clone();
    if let Some(build) = &p.build {
        match step(build, &p.dir, "", COMPILE_LIMIT) {
            Ok(c) => {
                let ok = c.ok;
                send(CodeEvent { kind: "compile".into(), text: format!("{}{}", c.stdout, c.stderr), ok, ms: c.ms, file: file.clone(), ..Default::default() });
                if !ok {
                    send(CodeEvent { kind: "exit".into(), file, ..Default::default() });
                    let _ = std::fs::remove_dir_all(&p.dir);
                    return;
                }
            }
            Err(e) => {
                send(CodeEvent { kind: "exit".into(), text: e, file, ..Default::default() });
                let _ = std::fs::remove_dir_all(&p.dir);
                return;
            }
        }
    }
    let started = Instant::now();
    let spawned = crate::python::command(&p.start)
        .current_dir(&p.dir)
        .env("PATH", joined_path())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .env("GOCACHE", p.dir.join(".gocache"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            send(CodeEvent { kind: "exit".into(), text: format!("Couldn’t start {}: {e}", p.start[0]), file, ..Default::default() });
            let _ = std::fs::remove_dir_all(&p.dir);
            return;
        }
    };
    let mut stdin = child.stdin.take();
    if !input.is_empty() {
        if let Some(w) = stdin.as_mut() {
            let _ = w.write_all(input.as_bytes());
            if !input.ends_with('\n') {
                let _ = w.write_all(b"\n");
            }
            let _ = w.flush();
        }
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = std::sync::Arc::new(Mutex::new(Some(child)));
    live(|m| m.insert(id, Live { stdin, child: child.clone() }));
    let total = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let reader = |pipe: Option<Box<dyn Read + Send>>, kind: &'static str| {
        let send = send.clone();
        let total = total.clone();
        let child = child.clone();
        std::thread::spawn(move || {
            let Some(mut pipe) = pipe else { return };
            let mut buf = [0u8; 4096];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                let n = match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                if total.fetch_add(n, std::sync::atomic::Ordering::Relaxed) > LIVE_OUTPUT {
                    if let Some(c) = child.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                        let _ = c.kill();
                    }
                    send(CodeEvent { kind: "err".into(), text: "\n… (too much output: stopped)".into(), ..Default::default() });
                    break;
                }
                // Whole characters only: a multi-byte one split between reads waits for the rest.
                carry.extend_from_slice(&buf[..n]);
                let cut = match std::str::from_utf8(&carry) {
                    Ok(_) => carry.len(),
                    Err(e) if e.error_len().is_none() => e.valid_up_to(),
                    Err(_) => carry.len(),
                };
                let text = String::from_utf8_lossy(&carry[..cut]).into_owned();
                carry.drain(..cut);
                if !text.is_empty() {
                    send(CodeEvent { kind: kind.into(), text, ..Default::default() });
                }
            }
        })
    };
    let out_thread = reader(stdout.map(|p| Box::new(p) as Box<dyn Read + Send>), "out");
    let err_thread = reader(stderr.map(|p| Box::new(p) as Box<dyn Read + Send>), "err");
    let limit = (limit_secs > 0).then(|| Duration::from_secs(limit_secs.min(3600)));
    let mut timed_out = false;
    let status = loop {
        let done = {
            let mut guard = child.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_mut() {
                None => Some(None),
                Some(c) => match c.try_wait() {
                    Ok(Some(status)) => Some(Some(status)),
                    Ok(None) => {
                        if limit.is_some_and(|l| started.elapsed() > l) {
                            timed_out = true;
                            let _ = c.kill();
                            Some(c.wait().ok())
                        } else {
                            None
                        }
                    }
                    Err(_) => Some(None),
                },
            }
        };
        if let Some(status) = done {
            break status;
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    let _ = out_thread.join();
    let _ = err_thread.join();
    live(|m| m.remove(&id));
    let images = figures(&p.dir);
    let vars = workspace(&p.dir);
    let _ = std::fs::remove_dir_all(&p.dir);
    send(CodeEvent {
        kind: "exit".into(),
        text: if timed_out { format!("Stopped after {} seconds (the time limit).", limit.map(|l| l.as_secs()).unwrap_or(0)) } else { String::new() },
        ok: status.is_some_and(|s| s.success()),
        exit_code: status.and_then(|s| s.code()),
        ms: started.elapsed().as_millis() as u64,
        timed_out,
        file,
        images,
        workspace: vars,
        ..Default::default()
    });
}

/// Starts a live run and returns its id (its output arrives as `code-event`s).
#[tauri::command]
pub fn code_start(app: tauri::AppHandle, language: String, source: String, input: String, limit_secs: u64) -> Result<u64, String> {
    if input.len() > MAX_INPUT {
        return Err("That input is too long".into());
    }
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::thread::Builder::new().name(format!("code-{id}")).spawn(move || start_live(app, id, language, source, input, limit_secs)).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Types a line into a live run (`close`: then ends its input, like Ctrl+D).
#[tauri::command]
pub fn code_input(id: u64, text: String, close: bool) -> Result<(), String> {
    live(|m| {
        let run = m.get_mut(&id).ok_or("That program isn’t running")?;
        if let Some(w) = run.stdin.as_mut() {
            w.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
            let _ = w.flush();
        }
        if close {
            run.stdin = None;
        }
        Ok(())
    })
}

/// Stops a live run.
#[tauri::command]
pub fn code_stop(id: u64) {
    let child = live(|m| m.get(&id).map(|r| r.child.clone()));
    if let Some(child) = child {
        if let Some(c) = child.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = c.kill();
        }
    }
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

/// The pictures in a published report folded into its HTML (data: URLs), so it's one file.
pub fn inline_images(html: &str, dir: &Path) -> String {
    use base64::Engine;
    let mut out = html.to_string();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let mime = if name.ends_with(".png") { "image/png" } else if name.ends_with(".jpg") || name.ends_with(".jpeg") { "image/jpeg" } else { continue };
        if let Ok(bytes) = std::fs::read(entry.path()) {
            let data = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
            out = out.replace(&format!("src=\"{name}\""), &format!("src=\"{data}\""));
        }
    }
    out
}

/// A MATLAB/Octave script published as a report (its code, output and figures, with its %% section
/// titles), saved as `<name>.html` beside the script and returned as its path.
#[tauri::command]
pub async fn code_publish(app: AppHandle, name: String, source: String) -> Result<String, String> {
    // Checks the name, then the report sits beside the script.
    let target = file(&app, &name, "m")?.with_extension("html");
    tauri::async_runtime::spawn_blocking(move || {
        let p = prepare("matlab", &source)?;
        let l = lang("matlab").ok_or("No MATLAB")?;
        let tool = found(l).ok_or("MATLAB or Octave isn’t installed on this computer")?.swap_remove(0);
        let script = "publish('main.m', 'format', 'html', 'outputDir', 'published');";
        let program: Vec<String> = if is_matlab(&tool) {
            vec![tool, "-batch".into(), script.into()]
        } else {
            let cli = Path::new(&tool).file_stem().is_some_and(|n| n.to_string_lossy().contains("cli"));
            [vec![tool], if cli { vec!["--no-gui".into(), "--no-window-system".into()] } else { vec!["--no-gui".into()] }, vec!["--quiet".into(), "--no-init-file".into(), "--eval".into(), script.into()]].concat()
        };
        let result = (|| {
            let ran = step(&program, &p.dir, "", Duration::from_secs(MAX_RUN_LIMIT))?;
            let out = p.dir.join("published");
            let html = std::fs::read_to_string(out.join("main.html")).map_err(|_| format!("It didn’t publish: {}", ran.stderr.lines().take(4).collect::<Vec<_>>().join(" ")))?;
            let html = inline_images(&html, &out);
            std::fs::create_dir_all(target.parent().ok_or("No folder")?).map_err(|e| e.to_string())?;
            std::fs::write(&target, html).map_err(|e| e.to_string())?;
            Ok(target.to_string_lossy().into_owned())
        })();
        let _ = std::fs::remove_dir_all(&p.dir);
        result
    })
    .await
    .map_err(|e| e.to_string())?
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
    fn octave_brings_back_the_variables_a_program_left() {
        if !has("matlab") || is_matlab(&found(lang("matlab").unwrap()).unwrap()[0]) {
            return;
        }
        let out = run("matlab", "A = [1 2; 3 4];\nname = 'hi';\nstatus = 5;\nf = @(t) t.^2;", "", 90).unwrap();
        assert!(out.run.as_ref().unwrap().ok, "{}", out.run.unwrap().stderr);
        let get = |n: &str| out.workspace.iter().find(|v| v.name == n).cloned();
        assert_eq!(get("A"), Some(Variable { name: "A".into(), size: "2×2".into(), class: "double".into(), value: "[1 2;3 4]".into() }));
        assert_eq!(get("name").map(|v| v.value), Some("'hi'".into()));
        assert_eq!(get("status").map(|v| v.value), Some("5".into()));
        assert_eq!(get("f").map(|v| v.class), Some("function_handle".into()));
        assert!(out.workspace.iter().all(|v| !v.name.starts_with("bridgedeck_")));
    }

    #[test]
    fn octave_runs_matlab_functions_it_lacks() {
        if !has("matlab") || is_matlab(&found(lang("matlab").unwrap()).unwrap()[0]) {
            return;
        }
        let src = "parts = split('a, b , c', ',');\nfprintf('%s|', strip(parts){:}); fprintf('\\n');\nif contains('Hello', 'ell'), disp(join({'yes', 'it', 'works'})); end\nfprintf('%d %d\\n', height(zeros(2, 3)), width(zeros(2, 3)));";
        let out = run("matlab", src, "", 90).unwrap().run.unwrap();
        assert!(out.ok, "{}", out.stderr);
        assert!(out.stdout.contains("a|b|c|") && out.stdout.contains("yes it works") && out.stdout.contains("2 3"), "{}", out.stdout);
        // A toolbox function names its package when the package isn't installed.
        let pkg = run("matlab", "G = tf(1, [1 1]);", "", 90).unwrap().run.unwrap();
        assert!(pkg.ok || pkg.stderr.contains("control package"), "{}", pkg.stderr);
    }

    #[test]
    fn brings_back_the_plots_a_program_draws() {
        let has_mpl = has("python") && Command::new(&found(lang("python").unwrap()).unwrap()[0]).args(["-c", "import matplotlib"]).status().is_ok_and(|s| s.success());
        if has_mpl {
            let out = run("python", "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [1, 4, 9])\nplt.show()\nprint('drawn')", "", 60).unwrap();
            assert_eq!(out.run.unwrap().stdout.trim(), "drawn");
            assert_eq!(out.images.len(), 1);
            assert!(out.images[0].starts_with("iVBOR"), "a PNG");
        }
        // Octave draws with its Qt engine, which needs a screen (a Mac or PC has one).
        let octave_can_draw = has("matlab") && std::env::var_os("DISPLAY").is_some() && !found(lang("matlab").unwrap()).unwrap()[0].contains("cli");
        if octave_can_draw {
            let out = run("matlab", "x = linspace(0, 1, 10);\nplot(x, x.^2);\ndisp('ok')", "", 90).unwrap();
            let r = out.run.unwrap();
            assert!(r.stdout.contains("ok"), "{}", r.stderr);
            assert_eq!(out.images.len(), 1, "{}", r.stderr);
        }
    }

    #[test]
    fn refuses_unknown_languages_and_odd_file_names() {
        assert!(run("cobol", "", "", 1).is_err());
        assert!(LANGS.iter().all(|l| !l.ext.contains('.')));
    }

    #[test]
    fn published_figures_are_folded_into_the_html() {
        let dir = std::env::temp_dir().join(format!("bd-publish-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main_01.png"), [0x89, b'P', b'N', b'G']).unwrap();
        let html = inline_images(r#"<p>x</p><img src="main_01.png"><img src="missing.png">"#, &dir);
        assert!(html.contains(r#"src="data:image/png;base64,iVBORw==""#), "{html}");
        assert!(html.contains(r#"src="missing.png""#));
        let _ = std::fs::remove_dir_all(dir);
    }
}