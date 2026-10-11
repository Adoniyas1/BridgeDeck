import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { MIMIR_HOME, readJsonFile, writeJsonFile } from "../config/store.js";
import { serverPath } from "../mcp/manager.js";
import { applyTeamPreset, loadTeamConfig } from "../team/config.js";
import { clearProbeCache } from "../team/endpoints.js";
import type { SetupConfig, SetupStep, SetupView, StorageItem } from "../../shared/types.js";
import { cleanSetupConfig, isLocalModel, localSwapUrl, mergeSetupConfig, pickAssets, releaseTool, SETUP_VERSION, swapYaml, type ReleaseTool } from "./plan.js";
import { availableMemory, checkRoom } from "./memory.js";

/**
 * Settings → Model servers: gets llama-swap and the team's models running on this computer
 * without opening a terminal. Mimir downloads llama-swap (and uv or llama.cpp) from their GitHub
 * releases into ~/.mimir/bin, writes ~/.mimir/llama-swap.yaml, runs llama-swap in the background,
 * and warms each model up (the first start downloads it).
 */

const FILE = "setup.json";
export const BIN_DIR = path.join(MIMIR_HOME, "bin");
export const SWAP_CONFIG = path.join(MIMIR_HOME, "llama-swap.yaml");

export async function loadSetupConfig(): Promise<SetupConfig> {
  const raw = await readJsonFile<unknown>(FILE, {});
  const config = cleanSetupConfig(raw);
  // First run on a Mac (or the old MLX setup): use models already on this Mac when there are some.
  if ((raw as { version?: number }).version !== SETUP_VERSION && config.computer === "mac") {
    const picked = pickModels(await findLocal());
    if (picked.head) config.models.head.source = picked.head;
    if (picked.executor) config.models.executor.source = picked.executor;
    await writeJsonFile(FILE, config);
  }
  return config;
}

export async function saveSetupConfig(patch: Partial<SetupConfig>): Promise<SetupConfig> {
  const next = mergeSetupConfig(await loadSetupConfig(), patch);
  await writeJsonFile(FILE, next);
  return next;
}

/** A program's full path on PATH (plus Mimir's own folders), or null. */
export function findCommand(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = serverPath(env.PATH).split(process.platform === "win32" ? ";" : ":");
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of dirs) for (const n of names) if (dir && existsSync(path.join(dir, n))) return path.join(dir, n);
  return null;
}

/** Where to look for models and llama.cpp builds already on this computer. */
const SEARCH_ROOTS = ["Bonsai-demo", "models", path.join(".mimir", "models"), "Downloads", "llama.cpp"];

/** .gguf models and llama-server programs under the usual folders (Bonsai-demo first). */
export async function findLocal(home = os.homedir()): Promise<{ models: Array<{ path: string; bytes: number }>; servers: string[] }> {
  const models: Array<{ path: string; bytes: number }> = [];
  const servers: string[] = [];
  let budget = 20_000;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5 || budget <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget <= 0) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/^(node_modules|\.git|\.venv|venv|__pycache__)$/.test(e.name)) await walk(full, depth + 1);
      } else if (/\.gguf$/i.test(e.name) && !/mmproj/i.test(e.name)) {
        try {
          models.push({ path: full, bytes: (await lstat(full)).size });
        } catch {
          /* gone */
        }
      } else if (e.name === "llama-server" || e.name === "llama-server.exe") servers.push(full);
    }
  };
  for (const root of SEARCH_ROOTS) await walk(path.join(home, root), 0);
  return { models, servers };
}

/** The models to use from what's on this computer: Ternary Bonsai 8B as Executor, Qwen3.5-9B as
 * Head (IQ3_XXS scored best in your benchmark, then IQ2_M). */
export function pickModels(found: { models: Array<{ path: string }> }): { head: string | null; executor: string | null } {
  const names = found.models.map((m) => m.path);
  const base = (p: string) => path.basename(p);
  const executor = names.filter((p) => /bonsai/i.test(base(p)) && /8b/i.test(p)).sort((a, b) => Number(/PQ2/i.test(base(b))) - Number(/PQ2/i.test(base(a))))[0] ?? null;
  const rank = (p: string) => (/IQ3_XXS/i.test(p) ? 0 : /IQ2_M/i.test(p) ? 1 : /Q3/i.test(p) ? 2 : /Q4/i.test(p) ? 3 : 4);
  const head = names.filter((p) => /qwen3[._-]?5.*9b/i.test(base(p))).sort((a, b) => rank(base(a)) - rank(base(b)))[0] ?? null;
  return { head, executor };
}

/** The llama-server to run: the one chosen in Settings, else Bonsai-demo's build (it reads PQ2_0
 * files), else Mimir's own or one on PATH. */
async function findServer(config: SetupConfig): Promise<string | null> {
  if (config.serverPath && existsSync(config.serverPath)) return config.serverPath;
  const local = (await findLocal()).servers;
  const bonsai = local.find((s) => s.includes(`Bonsai-demo${path.sep}bin`)) ?? local.find((s) => s.includes("Bonsai-demo"));
  return bonsai ?? findCommand("llama-server") ?? local[0] ?? null;
}

/** Things that take up space for local models: the MLX downloads from the old Mac setup (which can
 * go), and Ollama's models (shown, removed with `ollama rm`). */
export async function storageItems(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<StorageItem[]> {
  const hub = env.HF_HUB_CACHE || path.join(env.HF_HOME || path.join(home, ".cache", "huggingface"), "hub");
  const candidates: Array<Omit<StorageItem, "bytes">> = [
    { id: "mlx-qwen", label: "MLX Qwen3.5-9B 4-bit (old Mac setup)", path: path.join(hub, "models--mlx-community--Qwen3.5-9B-OptiQ-4bit"), deletable: true, hint: "Not used any more: the Mac now runs your GGUF files." },
    { id: "mlx-bonsai", label: "MLX Ternary Bonsai 8B (old Mac setup)", path: path.join(hub, "models--prism-ml--Ternary-Bonsai-8B-mlx-2bit"), deletable: true, hint: "A second copy of Bonsai; the GGUF one is used now." },
    { id: "mlx-lm", label: "mlx-lm and its Python (old Mac setup)", path: path.join(home, ".local", "share", "uv", "tools", "mlx-lm"), deletable: true, hint: "Only the MLX setup used it." },
    { id: "ollama", label: "Ollama models", path: path.join(home, ".ollama", "models"), deletable: false, hint: "Remove one with “ollama rm <name>” (see “ollama list”)." }
  ];
  const out: StorageItem[] = [];
  for (const c of candidates) {
    const bytes = await diskUsage(c.path);
    if (bytes > 0) out.push({ ...c, bytes });
  }
  return out;
}

/** Bytes used under a folder, not following links (Hugging Face's cache links into its own blobs). */
async function diskUsage(target: string): Promise<number> {
  let info;
  try {
    info = await lstat(target);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.isSymbolicLink() ? 0 : info.size;
  let total = 0;
  for (const name of await readdir(target).catch(() => [] as string[])) total += await diskUsage(path.join(target, name));
  return total;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, PATH: serverPath(process.env.PATH) }, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (d: Buffer) => (output = (output + d.toString()).slice(-20_000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 20 * 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

type Fetch = typeof fetch;

/** Downloads a tool's latest release files and puts its programs in ~/.mimir/bin. */
export async function installRelease(tool: ReleaseTool, fetchImpl: Fetch = fetch, binDir = BIN_DIR): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${tool.repo}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "mimir" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${tool.repo}'s releases.`);
  const release = (await res.json()) as { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> };
  const assets = pickAssets(tool, release.assets ?? []);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "mimir-install-"));
  try {
    const dest = tool.subdir ? path.join(binDir, tool.subdir) : binDir;
    await mkdir(dest, { recursive: true });
    for (const asset of assets) {
      const file = path.join(scratch, asset.name);
      const download = await fetchImpl(asset.browser_download_url, { headers: { "user-agent": "mimir" } });
      if (!download.ok || !download.body) throw new Error(`Couldn't download ${asset.name} (${download.status}).`);
      await pipeline(Readable.fromWeb(download.body as WebReadableStream<Uint8Array>), createWriteStream(file));
      const unpacked = path.join(scratch, `${asset.name}.d`);
      await mkdir(unpacked);
      // bsdtar (macOS, Windows 10+) reads both .zip and .tar.gz.
      const { code, output } = await run("tar", ["-xf", file, "-C", unpacked]);
      if (code !== 0) throw new Error(`Couldn't unpack ${asset.name}: ${output.trim().slice(-300)}`);
      for (const f of await listFiles(unpacked)) {
        if (tool.files && !tool.files.includes(path.basename(f))) continue;
        const target = path.join(dest, path.basename(f));
        await copyFile(f, target);
        if (process.platform !== "win32") await chmod(target, 0o755);
      }
    }
    return `Installed ${tool.repo} ${release.tag_name ?? ""} in ${dest}.`.replace("  ", " ");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Whether a model's files are already downloaded (Hugging Face's cache, or llama.cpp's). */
export function modelCached(source: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): boolean {
  if (isLocalModel(source)) return existsSync(source.replace(/^~(?=\/)/, home));
  const [repo] = source.split(":");
  const [org, name] = (repo ?? "").split("/");
  if (!org || !name) return false;
  const hfHub = env.HF_HUB_CACHE || path.join(env.HF_HOME || path.join(home, ".cache", "huggingface"), "hub");
  if (existsSync(path.join(hfHub, `models--${org}--${name}`))) return true;
  const llamaCache =
    env.LLAMA_CACHE ||
    (platform === "win32"
      ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "llama.cpp")
      : platform === "darwin"
        ? path.join(home, "Library", "Caches", "llama.cpp")
        : path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "llama.cpp"));
  try {
    return existsSync(llamaCache) && readdirSync(llamaCache).some((f) => f.startsWith(`${org}_${name}`) && f.endsWith(".gguf"));
  } catch {
    return false;
  }
}

/** llama-swap, run by Mimir in the background. */
class SwapProcess {
  private child: ChildProcess | null = null;
  private log = "";

  get running(): boolean {
    return this.child !== null;
  }

  get output(): string {
    return this.log;
  }

  start(config: SetupConfig): void {
    if (this.child) return;
    const bin = findCommand("llama-swap");
    if (!bin) throw new Error("llama-swap isn't installed yet.");
    this.log = "";
    const child = spawn(bin, ["--config", SWAP_CONFIG, "--listen", config.listen], { env: { ...process.env, PATH: serverPath(process.env.PATH) }, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const keep = (d: Buffer) => (this.log = (this.log + d.toString()).slice(-8000));
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (err) => {
      this.log += `\n${err.message}`;
      if (this.child === child) this.child = null;
    });
    child.on("close", (code) => {
      this.log += `\nllama-swap stopped (${code}).`;
      if (this.child === child) this.child = null;
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    // On Windows a plain kill leaves the model servers it started running (and holding VRAM).
    if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill();
  }
}

export const swap = new SwapProcess();

async function answers(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    return (await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })).ok;
  } catch {
    return false;
  }
}

async function fileText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/** The steps for this computer and how far along each one is. */
export async function setupView(): Promise<SetupView> {
  const config = await loadSetupConfig();
  const mac = config.computer === "mac";
  const found = await findLocal();
  const server = await findServer(config);
  const yaml = swapYaml(config, server ?? "llama-server");
  const written = await fileText(SWAP_CONFIG);
  const up = await answers(localSwapUrl(config));
  const team = await loadTeamConfig();
  const preset = mac ? "mac-mlx" : "windows-llamacpp";
  const step = (s: Omit<SetupStep, "note"> & { note?: string }): SetupStep => ({ note: "", ...s });
  const has = (name: string) => findCommand(name) !== null;
  const ready = (["head", "executor"] as const).filter((r) => modelCached(config.models[r].source));

  const steps: SetupStep[] = [
    step({
      id: "llama.cpp",
      title: mac ? "llama.cpp (Bonsai's build)" : "llama.cpp (CUDA)",
      detail: mac
        ? "llama-server runs the models on the Mac's GPU. PrismML's build reads Ternary Bonsai's PQ2_0 files; Mimir uses the one in ~/Bonsai-demo when it's there."
        : "llama-server for the NVIDIA card: Mimir gets the CUDA build and its runtime from llama.cpp's releases. Needs a current NVIDIA driver.",
      command: mac ? "cd ~/Bonsai-demo && ./setup.sh" : "winget install llama.cpp   (Vulkan build: works, a bit slower)",
      action: process.platform === "darwin" || process.platform === "win32" ? (server ? "Update" : "Install") : null,
      state: server ? "done" : "todo",
      note: server ? `Using ${server}` : ""
    }),
    step({
      id: "models",
      title: "Models",
      detail: mac
        ? "Qwen3.5-9B IQ3_XXS plans and checks; Ternary Bonsai 8B (PQ2_0) does the tool steps. Files already on this Mac are used as they are, nothing is copied."
        : "Downloaded the first time each one starts.",
      command: null,
      action: "Look again",
      state: ready.length === 2 ? "done" : "todo",
      note: (["head", "executor"] as const).map((r) => `${config.models[r].name}: ${modelCached(config.models[r].source) ? config.models[r].source : `${config.models[r].source} (downloaded on first start)`}`).join("\n")
    }),
    step({
      id: "llama-swap",
      title: "llama-swap",
      detail: "One address (port 8080) for both models; it starts each model's server when the team asks for it, one at a time.",
      command: mac ? "brew tap mostlygeek/llama-swap && brew install llama-swap" : "Download llama-swap from github.com/mostlygeek/llama-swap/releases",
      action: has("llama-swap") ? "Update" : "Install",
      state: has("llama-swap") ? "done" : "todo"
    }),
    step({
      id: "config",
      title: "Model list",
      detail: `Writes ${SWAP_CONFIG} with the two models${config.keepBothLoaded ? ", kept loaded together" : ", taking turns in memory"}.`,
      command: null,
      action: written === yaml ? "Write again" : "Write it",
      state: written === yaml ? "done" : written ? "error" : "todo",
      note: written && written !== yaml ? "The file is out of date with these settings (it may still list the old MLX models). Write it again before starting." : ""
    }),
    step({
      id: "start",
      title: "Run llama-swap",
      detail: mac
        ? "Mimir runs it in the background; it listens on this Mac only."
        : `Mimir runs it in the background on ${config.listen}. Listening on 0.0.0.0 lets the Mac reach it (allow it through Windows Firewall on private networks); anyone on your network can use it too.`,
      command: `llama-swap --config "${SWAP_CONFIG}" --listen ${config.listen}`,
      action: swap.running ? "Stop" : up ? null : "Start",
      state: up ? "done" : "todo",
      note: up && !swap.running ? "Something is already answering on this port (llama-swap started elsewhere?)." : ""
    }),
    step({
      id: "warm-up",
      title: "Load the models once",
      detail: `Loads each model and sends it a one-word message${mac ? "" : " (the first start downloads it: about 20 GB for the Head, 6 GB for the Executor)"}. Before each load Mimir checks there's enough free memory and stops instead of letting the computer run out.`,
      command: null,
      action: up ? "Warm up" : null,
      state: "todo"
    }),
    step({
      id: "team",
      title: "Use them for the Brain team",
      detail: `Applies the “${mac ? "This Mac" : "This Windows PC (llama.cpp)"}” preset. To use the PC from the Mac, choose “This Mac, using the PC when it's on” in Brain team instead.`,
      command: null,
      action: team.preset === preset || team.preset === "mac-with-pc" ? null : "Use them",
      state: team.preset === preset || team.preset === "mac-with-pc" ? "done" : "todo"
    })
  ];
  return {
    config,
    found,
    server,
    memory: { availableBytes: await availableMemory(), totalBytes: os.totalmem() },
    storage: await storageItems(),
    steps,
    yaml,
    configPath: SWAP_CONFIG,
    swapRunning: swap.running,
    swapLog: swap.output
  };
}

/** Does one step's action. Returns what happened, for the step's note. */
export async function runSetupStep(id: string): Promise<string> {
  const config = await loadSetupConfig();
  if (id.startsWith("free:")) {
    const item = (await storageItems()).find((s) => `free:${s.id}` === id);
    if (!item || !item.deletable) throw new Error("That can't be removed from here.");
    await rm(item.path, { recursive: true, force: true });
    return `Removed ${item.label} (${(item.bytes / 1024 ** 3).toFixed(1)} GB).`;
  }
  switch (id) {
    case "llama-swap":
    case "llama.cpp": {
      const tool = releaseTool(id);
      if (!tool) throw new Error(`Mimir can't install ${id} on this computer; use the command shown.`);
      // A running program can't be replaced (on Windows); start it again afterwards.
      const wasRunning = swap.running;
      if (wasRunning) swap.stop();
      const message = await installRelease(tool);
      if (wasRunning) swap.start(config);
      return message;
    }
    case "models": {
      const picked = pickModels(await findLocal());
      const models = { head: { ...config.models.head }, executor: { ...config.models.executor } };
      if (config.computer === "mac") {
        if (picked.head) models.head.source = picked.head;
        if (picked.executor) models.executor.source = picked.executor;
      }
      await saveSetupConfig({ models });
      return picked.head || picked.executor ? `Found ${[picked.head, picked.executor].filter(Boolean).map((p) => path.basename(p!)).join(" and ")}.` : "No models found in ~/Bonsai-demo, ~/models or ~/Downloads; they'll download on first start.";
    }
    case "config": {
      const server = await findServer(config);
      await mkdir(path.dirname(SWAP_CONFIG), { recursive: true });
      await writeFile(SWAP_CONFIG, swapYaml(config, server ?? "llama-server"), "utf-8");
      return server ? `Wrote ${SWAP_CONFIG}.` : `Wrote ${SWAP_CONFIG}, but llama-server isn't installed yet.`;
    }
    case "start": {
      if (swap.running) {
        swap.stop();
        return "Stopped llama-swap.";
      }
      // Always start from a config that matches these settings (an old one may list MLX models).
      await runSetupStep("config");
      swap.start(config);
      const url = localSwapUrl(config);
      for (let i = 0; i < 20 && swap.running; i++) {
        if (await answers(url)) {
          clearProbeCache();
          return `llama-swap is answering at ${url}.`;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`llama-swap didn't come up: ${swap.output.trim().slice(-500) || "no output"}`);
    }
    case "warm-up": {
      const url = localSwapUrl(config);
      const done: string[] = [];
      for (const role of ["executor", "head"] as const) {
        const name = config.models[role].name;
        if (config.computer === "mac") await checkRoom(config, name);
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: name, messages: [{ role: "user", content: "Say ok." }], max_tokens: 4, chat_template_kwargs: { enable_thinking: false } }),
          signal: AbortSignal.timeout(45 * 60_000)
        });
        if (!res.ok) throw new Error(`${name} didn't load (${res.status}): ${(await res.text()).slice(0, 400)}`);
        done.push(name);
      }
      return `Loaded ${done.join(" and ")}.`;
    }
    case "team": {
      await applyTeamPreset(config.computer === "mac" ? "mac-mlx" : "windows-llamacpp", undefined, localSwapUrl(config));
      clearProbeCache();
      return "The Brain team now uses these models.";
    }
    default:
      throw new Error(`No setup step called ${id}`);
  }
}

/** At startup: run llama-swap when asked to and nothing answers on its port yet. */
export async function autostartSwap(): Promise<void> {
  const config = await loadSetupConfig();
  if (!config.autostart || !existsSync(SWAP_CONFIG) || !findCommand("llama-swap")) return;
  // Never start an out-of-date list (an old one may still name the MLX models that ran out of memory).
  if ((await fileText(SWAP_CONFIG)) !== swapYaml(config, (await findServer(config)) ?? "llama-server")) return;
  if (await answers(localSwapUrl(config))) return;
  try {
    swap.start(config);
  } catch {
    /* shown in Settings → Model servers */
  }
}
