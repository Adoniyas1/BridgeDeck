//! Where the memory goes, for Settings → Activity on an 8 GB computer: BridgeDeck itself, its web
//! pages (each a process of its own), Mimir, Hermes and the AI models, and the biggest other apps.

use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub name: String,
    pub bytes: u64,
    pub count: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    pub total: u64,
    pub available: u64,
    pub swap_used: u64,
    /// BridgeDeck's own parts, biggest first.
    pub groups: Vec<Usage>,
    /// The biggest other apps (by program name).
    pub others: Vec<Usage>,
}

/// Which of BridgeDeck's parts a process is, from its name and command line; None for other apps.
pub fn group_of(name: &str, cmd: &str, own: bool) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    let cmd = cmd.to_ascii_lowercase();
    if own {
        return Some("BridgeDeck");
    }
    if ["llama-server", "llama-swap", "ollama", "mlx_lm", "mlx-lm", "whisper-server"].iter().any(|a| name.starts_with(a) || cmd.contains(a)) {
        return Some("AI models");
    }
    if cmd.contains("hermes") && !cmd.contains("mimir") {
        return Some("Hermes");
    }
    if cmd.contains("mimir") && (name.starts_with("node") || name.contains("mimir") || name.contains("electron")) {
        return Some("Mimir");
    }
    // The pages BridgeDeck shows (the browser, TV, Spotify, mail): WebKit on the Mac and Linux,
    // WebView2 on Windows. On the Mac, Safari's pages are counted with them.
    if name.contains("webkit.webcontent") || name.contains("webkitwebprocess") || name.contains("webkit.gpu") || name.contains("webkit.networking") || name.starts_with("msedgewebview2") {
        return Some("Web pages");
    }
    None
}

/// Sums the processes into BridgeDeck's parts and the biggest other apps.
pub fn summarize(processes: impl IntoIterator<Item = (String, String, bool, u64)>, others: usize) -> (Vec<Usage>, Vec<Usage>) {
    let mut groups: HashMap<String, Usage> = HashMap::new();
    let mut rest: HashMap<String, Usage> = HashMap::new();
    for (name, cmd, own, bytes) in processes {
        let (map, key) = match group_of(&name, &cmd, own) {
            Some(g) => (&mut groups, g.to_string()),
            None => (&mut rest, name.trim_end_matches(".exe").to_string()),
        };
        let u = map.entry(key.clone()).or_insert(Usage { name: key, bytes: 0, count: 0 });
        u.bytes += bytes;
        u.count += 1;
    }
    let sorted = |m: HashMap<String, Usage>, n: usize| {
        let mut v: Vec<Usage> = m.into_values().collect();
        v.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.name.cmp(&b.name)));
        v.truncate(n);
        v
    };
    (sorted(groups, 8), sorted(rest, others))
}

fn read() -> MemoryReport {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let me = sysinfo::get_current_pid().ok();
    let processes = system.processes().iter().map(|(pid, p)| {
        let cmd = p.cmd().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" ");
        (p.name().to_string_lossy().to_string(), cmd, Some(*pid) == me, p.memory())
    });
    let (groups, others) = summarize(processes, 6);
    MemoryReport { total: system.total_memory(), available: system.available_memory(), swap_used: system.used_swap(), groups, others }
}

#[tauri::command]
pub async fn memory_report() -> Result<MemoryReport, String> {
    tauri::async_runtime::spawn_blocking(read).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_processes_into_bridgedecks_parts_and_other_apps() {
        let mb = 1024 * 1024;
        let (groups, others) = summarize(
            vec![
                ("bridgedeck".into(), "".into(), true, 300 * mb),
                ("com.apple.WebKit.WebContent".into(), "".into(), false, 200 * mb),
                ("com.apple.WebKit.WebContent".into(), "".into(), false, 150 * mb),
                ("node".into(), "node /Users/a/Mimir/dist/main/server.js".into(), false, 250 * mb),
                ("llama-server".into(), "llama-server -m qwen.gguf".into(), false, 3000 * mb),
                ("python3".into(), "python3 -m mlx_lm.server".into(), false, 900 * mb),
                ("hermes".into(), "hermes acp".into(), false, 120 * mb),
                ("Google Chrome Helper".into(), "".into(), false, 400 * mb),
                ("Google Chrome Helper".into(), "".into(), false, 300 * mb),
                ("Discord.exe".into(), "".into(), false, 500 * mb),
                ("node".into(), "node other-project/index.js".into(), false, 80 * mb),
            ],
            2,
        );
        let names: Vec<_> = groups.iter().map(|g| (g.name.as_str(), g.bytes / mb, g.count)).collect();
        assert_eq!(names, vec![("AI models", 3900, 2), ("Web pages", 350, 2), ("BridgeDeck", 300, 1), ("Mimir", 250, 1), ("Hermes", 120, 1)]);
        let others: Vec<_> = others.iter().map(|g| (g.name.as_str(), g.bytes / mb)).collect();
        assert_eq!(others, vec![("Google Chrome Helper", 700), ("Discord", 500)]);
    }
}
