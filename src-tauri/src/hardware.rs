//! This computer's memory: RAM, and the graphics card's own memory (VRAM). NVIDIA cards report
//! through nvidia-smi (installed with the driver); other Windows cards through the display driver's
//! registry entry, which has the full amount (WMI's AdapterRAM stops at 4 GB). A Mac's GPU shares
//! the Mac's memory, so its "VRAM" is the RAM.

use serde::Serialize;
use std::process::{Command, Stdio};

const MB: u64 = 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    pub total_bytes: u64,
    pub used_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    /// Shares the computer's memory (a Mac).
    pub shared: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub ram_total: u64,
    pub ram_available: u64,
    pub cpu: String,
    pub cores: usize,
    pub gpus: Vec<Gpu>,
}

fn quiet(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = command.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// nvidia-smi's CSV: name, total, used, free (MiB), one card a line.
pub fn parse_nvidia_smi(text: &str) -> Vec<Gpu> {
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split(',').map(str::trim).collect();
            let [name, total, used, free] = cols[..] else { return None };
            Some(Gpu { name: name.to_string(), total_bytes: total.parse::<u64>().ok()? * MB, used_bytes: used.parse::<u64>().ok().map(|v| v * MB), free_bytes: free.parse::<u64>().ok().map(|v| v * MB), shared: false })
        })
        .filter(|g| !g.name.is_empty())
        .collect()
}

/// The display drivers' "name|bytes" lines.
pub fn parse_registry(text: &str) -> Vec<Gpu> {
    text.lines()
        .filter_map(|line| {
            let (name, bytes) = line.split_once('|')?;
            let bytes: u64 = bytes.trim().parse().ok().filter(|b| *b > 0)?;
            Some(Gpu { name: name.trim().to_string(), total_bytes: bytes, used_bytes: None, free_bytes: None, shared: false })
        })
        .filter(|g| !g.name.is_empty())
        .collect()
}

/// NVIDIA cards with how much of their memory is in use (empty without an NVIDIA driver).
pub fn nvidia() -> Vec<Gpu> {
    let candidates: &[&str] = if cfg!(windows) { &["nvidia-smi", "C:\\Windows\\System32\\nvidia-smi.exe", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"] } else { &["nvidia-smi", "/usr/bin/nvidia-smi"] };
    candidates
        .iter()
        .find_map(|p| quiet(p, &["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"]).map(|t| parse_nvidia_smi(&t)).filter(|g| !g.is_empty()))
        .unwrap_or_default()
}

pub fn gpus(ram_total: u64) -> Vec<Gpu> {
    if cfg!(target_os = "macos") {
        let chip = quiet("sysctl", &["-n", "machdep.cpu.brand_string"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Apple".into());
        return vec![Gpu { name: format!("{chip} GPU (shares the Mac's memory)"), total_bytes: ram_total, used_bytes: None, free_bytes: None, shared: true }];
    }
    let cards = nvidia();
    if !cards.is_empty() || !cfg!(windows) {
        return cards;
    }
    let script = "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}' -f $_.DriverDesc, $_.'HardwareInformation.qwMemorySize' }";
    quiet("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", script]).map(|t| parse_registry(&t)).unwrap_or_default()
}

pub fn read() -> Hardware {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.refresh_cpu_all();
    let cpu = system.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    let ram_total = system.total_memory();
    Hardware { ram_total, ram_available: system.available_memory(), cpu, cores: system.cpus().len(), gpus: gpus(ram_total) }
}

/// "16.0 GB RAM · NVIDIA GeForce RTX 4070 Ti, 12.0 GB VRAM", for the activity log.
pub fn summary(h: &Hardware) -> String {
    let gb = |b: u64| format!("{:.1} GB", b as f64 / (1024.0 * 1024.0 * 1024.0));
    let mut parts = vec![format!("{} RAM ({} free)", gb(h.ram_total), gb(h.ram_available))];
    if !h.cpu.is_empty() {
        parts.push(format!("{} ({} threads)", h.cpu, h.cores));
    }
    for g in &h.gpus {
        parts.push(if g.shared { g.name.clone() } else { format!("{}, {} VRAM{}", g.name, gb(g.total_bytes), g.free_bytes.map(|f| format!(" ({} free)", gb(f))).unwrap_or_default()) });
    }
    if h.gpus.is_empty() {
        parts.push("no graphics card memory found".into());
    }
    parts.join(" · ")
}

#[tauri::command]
pub async fn hardware_info() -> Hardware {
    tauri::async_runtime::spawn_blocking(read).await.unwrap_or(Hardware { ram_total: 0, ram_available: 0, cpu: String::new(), cores: 0, gpus: vec![] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_nvidia_smi_and_the_registry() {
        let gpus = parse_nvidia_smi("NVIDIA GeForce RTX 4070 Ti, 12282, 1024, 11000\r\n");
        assert_eq!(gpus, vec![Gpu { name: "NVIDIA GeForce RTX 4070 Ti".into(), total_bytes: 12282 * MB, used_bytes: Some(1024 * MB), free_bytes: Some(11000 * MB), shared: false }]);
        assert!(parse_nvidia_smi("NVIDIA-SMI has failed").is_empty());
        let reg = parse_registry("AMD Radeon RX 7800 XT|17163091968\r\nMicrosoft Basic Display Adapter|\r\n");
        assert_eq!(reg.len(), 1);
        assert_eq!(reg[0].total_bytes, 17163091968);
        let h = Hardware { ram_total: 16 * 1024 * MB, ram_available: 8 * 1024 * MB, cpu: "Ryzen".into(), cores: 16, gpus };
        assert_eq!(summary(&h), "16.0 GB RAM (8.0 GB free) · Ryzen (16 threads) · NVIDIA GeForce RTX 4070 Ti, 12.0 GB VRAM (10.7 GB free)");
    }
}
