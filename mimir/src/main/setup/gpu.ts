import { execFile } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GpuInfo } from "../../shared/types.js";
import { isLocalModel, type LayerSplit } from "./plan.js";

/**
 * The graphics card and its memory (VRAM), and how much of each model goes on it.
 *
 * NVIDIA cards report through nvidia-smi (it comes with the driver). Other Windows cards fall back to
 * the display driver's registry entry, which has the card's full memory (WMI's AdapterRAM stops at
 * 4 GB). A Mac's GPU shares the computer's memory. A model's layers are split between the GPU and
 * the CPU by `gpuShare`: at 80, 80 % of its layers load on the card and the rest run on the CPU from
 * system RAM, which keeps VRAM free for everything else at the cost of some speed.
 */

const MB = 1024 ** 2;

const run = (file: string, args: string[], timeout = 4000) =>
  new Promise<string>((resolve) => execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout))));

/** nvidia-smi's CSV (name, total, used, free in MiB), one line per card. */
export function parseNvidiaSmi(text: string): GpuInfo[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(",").map((s) => s.trim()))
    .filter((cols) => cols.length >= 4 && cols[0] && !Number.isNaN(Number(cols[1])))
    .map(([name, total, used, free]) => ({ name: name!, vendor: "nvidia" as const, totalBytes: Number(total) * MB, usedBytes: Number(used) * MB, freeBytes: Number(free) * MB, shared: false }));
}

/** The display drivers' "name|bytes" lines from the registry (HardwareInformation.qwMemorySize). */
export function parseRegistryGpus(text: string): GpuInfo[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("|").map((s) => s.trim()))
    .filter(([name, bytes]) => name && Number(bytes) > 0)
    .map(([name, bytes]) => ({ name: name!, vendor: /nvidia/i.test(name!) ? "nvidia" : /amd|radeon/i.test(name!) ? "amd" : /intel/i.test(name!) ? "intel" : "other", totalBytes: Number(bytes), usedBytes: null, freeBytes: null, shared: false }));
}

const NVIDIA_SMI = ["nvidia-smi", "C:\\Windows\\System32\\nvidia-smi.exe", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe", "/usr/bin/nvidia-smi"];

const REGISTRY_SCRIPT =
  "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}' -f $_.DriverDesc, $_.'HardwareInformation.qwMemorySize' }";

let cache: { at: number; gpus: GpuInfo[] } | null = null;

/** The graphics cards here and their memory (checked at most every 5 seconds). */
export async function gpuInfo(platform: NodeJS.Platform = process.platform): Promise<GpuInfo[]> {
  if (cache && Date.now() - cache.at < 5000) return cache.gpus;
  let gpus: GpuInfo[] = [];
  if (platform === "darwin") {
    // Apple silicon: the GPU uses the Mac's own memory, so its "VRAM" is the RAM.
    const chip = (await run("sysctl", ["-n", "machdep.cpu.brand_string"])).trim() || "Apple GPU";
    gpus = [{ name: `${chip} GPU (shares the Mac's memory)`, vendor: "apple", totalBytes: os.totalmem(), usedBytes: null, freeBytes: null, shared: true }];
  } else {
    for (const smi of NVIDIA_SMI) {
      if (smi.includes("\\") && !existsSync(smi)) continue;
      gpus = parseNvidiaSmi(await run(smi, ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"]));
      if (gpus.length) break;
    }
    if (!gpus.length && platform === "win32") gpus = parseRegistryGpus(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", REGISTRY_SCRIPT], 8000));
  }
  cache = { at: Date.now(), gpus };
  return gpus;
}

// ---- How many layers a model has ----

/** The model file for a source: the .gguf itself, or the copy llama.cpp or Hugging Face downloaded. */
export function modelFile(source: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): string | null {
  if (isLocalModel(source)) {
    const p = source.replace(/^~(?=\/)/, home);
    return existsSync(p) ? p : null;
  }
  const [repo, quant = ""] = source.split(":");
  const [org, name] = (repo ?? "").split("/");
  if (!org || !name) return null;
  const matches = (f: string) => f.toLowerCase().endsWith(".gguf") && f.toLowerCase().includes(quant.toLowerCase()) && !/mmproj/i.test(f);
  const llamaCache =
    env.LLAMA_CACHE ||
    (platform === "win32"
      ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "llama.cpp")
      : platform === "darwin"
        ? path.join(home, "Library", "Caches", "llama.cpp")
        : path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "llama.cpp"));
  try {
    const f = readdirSync(llamaCache).find((x) => x.startsWith(`${org}_${name}`) && matches(x));
    if (f) return path.join(llamaCache, f);
  } catch {
    /* no cache */
  }
  const snapshots = path.join(env.HF_HUB_CACHE || path.join(env.HF_HOME || path.join(home, ".cache", "huggingface"), "hub"), `models--${org}--${name}`, "snapshots");
  try {
    for (const snap of readdirSync(snapshots)) {
      const f = readdirSync(path.join(snapshots, snap)).find(matches);
      if (f) return path.join(snapshots, snap, f);
    }
  } catch {
    /* not downloaded */
  }
  return null;
}

/** The layer count (`<arch>.block_count`) from a GGUF file's header, or null. */
export function ggufLayers(file: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = Math.min(statSync(file).size, 8 * MB);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return ggufBlockCount(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Reads GGUF metadata (v2/v3) from the start of a file until the block count turns up. */
export function ggufBlockCount(buf: Buffer): number | null {
  if (buf.length < 24 || buf.toString("latin1", 0, 4) !== "GGUF") return null;
  let at = 8;
  const u64 = () => { const v = Number(buf.readBigUInt64LE(at)); at += 8; return v; };
  const str = () => { const n = u64(); const s = buf.toString("utf8", at, at + n); at += n; return s; };
  const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const skip = (type: number): void => {
    if (type === 8) { str(); return; }
    if (type === 9) {
      const inner = buf.readUInt32LE(at); at += 4;
      const n = u64();
      if (inner !== 8 && inner !== 9) { at += n * (SIZES[inner] ?? 0); return; }
      for (let i = 0; i < n; i++) skip(inner);
      return;
    }
    at += SIZES[type] ?? Infinity;
  };
  try {
    u64(); // tensor count
    const kvs = u64();
    for (let i = 0; i < kvs && at < buf.length; i++) {
      const key = str();
      const type = buf.readUInt32LE(at); at += 4;
      if (key.endsWith(".block_count") && (type === 4 || type === 5)) return buf.readUInt32LE(at);
      if (key.endsWith(".block_count") && (type === 10 || type === 11)) return Number(buf.readBigUInt64LE(at));
      skip(type);
    }
  } catch {
    /* ran past what was read */
  }
  return null;
}

/** A model's layer count when its file isn't here to read: typical counts for its size. */
export function guessLayers(source: string): number {
  if (/70b|72b/i.test(source)) return 80;
  if (/32b|35b|30b/i.test(source)) return 64;
  if (/27b|24b|22b/i.test(source)) return 62;
  if (/14b|12b|13b/i.test(source)) return 48;
  if (/9b|8b|7b/i.test(source)) return 36;
  if (/4b|3b/i.test(source)) return 36;
  if (/1\.?\d?b|0\.\d+b/i.test(source)) return 28;
  return 40;
}

/** How a model's layers split between the GPU and the CPU at `share` percent on the GPU. */
export function layerSplit(source: string, share: number, read: (source: string) => number | null = (s) => { const f = modelFile(s); return f ? ggufLayers(f) : null; }): LayerSplit {
  const fromFile = read(source);
  const layers = fromFile ?? guessLayers(source);
  return { layers, onGpu: Math.max(0, Math.min(layers, Math.round((layers * share) / 100))), fromFile: fromFile !== null };
}

