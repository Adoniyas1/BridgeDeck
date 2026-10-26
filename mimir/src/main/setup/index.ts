import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { MIMIR_HOME, readJsonFile, writeJsonFile } from "../config/store.js";
import { serverPath } from "../mcp/manager.js";
import { applyTeamPreset, loadTeamConfig } from "../team/config.js";
import { clearProbeCache } from "../team/endpoints.js";
import type { SetupConfig, SetupStep, SetupView, StorageItem, TeamConfig } from "../../shared/types.js";
import { cleanSetupConfig, DEFAULT_MODELS, withContext, isLocalModel, isMoe, localSwapUrl, memoryNeeded, mergeSetupConfig, setupRoles, sharedNames, type LayerSplit, pickAssets, releaseTool, SETUP_VERSION, swapYaml, type ReleaseTool } from "./plan.js";
import { availableMemory, checkRoom } from "./memory.js";
import { gpuInfo, layerSplit, modelFile } from "./gpu.js";
import { keepTuning, logActivity, lowerShare, modelIdleFor, setIdleUnloader, pickShare, tokensPerSecond, TUNE_SHARES, underPressure, type TuneResult } from "./adaptive.js";

/**
 * Settings → Model servers: gets llama-swap and the team's models running on this computer
 * without opening a terminal. Mimir downloads llama-swap (and uv or llama.cpp) from their GitHub
 * releases into ~/.mimir/bin, writes ~/.mimir/llama-swap.yaml, runs llama-swap in the background,
 * and warms each model up (the first start downloads it).
 */

const FILE = "setup.json";
const ROLE_NAMES = { head: "Head", executor: "Executor", checker: "Checker" } as const;
export const BIN_DIR = path.join(MIMIR_HOME, "bin");
export const SWAP_CONFIG = path.join(MIMIR_HOME, "llama-swap.yaml");
/** Hermes's minimum context, as llama-server's -c (engines/hermes.ts HERMES_MIN_CONTEXT). */
const HERMES_CONTEXT = 65536;

export async function loadSetupConfig(): Promise<SetupConfig> {
  const raw = await readJsonFile<unknown>(FILE, {});
  const config = cleanSetupConfig(raw);
  // First run (or an older setup): use models already on this computer when there are some, and
  // move a Brain team that used this setup's old model names to the new ones.
  if ((raw as { version?: number }).version !== SETUP_VERSION) {
    applyPicks(config, pickModels(await findLocal(os.homedir(), config.modelDirs), config.computer));
    await writeJsonFile(FILE, config);
  }
  await syncTeamWithSetup(config);
  return config;
}

/** A Brain team still on this setup's preset follows its model names when they change (a preset
 * the user edited is no longer that preset, so it's left alone). Runs at startup and whenever the
 * setup is read, so an update can't leave the team asking llama-swap for models it doesn't have. */
export async function syncTeamWithSetup(config?: SetupConfig): Promise<boolean> {
  const setup = config ?? cleanSetupConfig(await readJsonFile<unknown>(FILE, {}));
  const team = await loadTeamConfig();
  const preset = setup.computer === "mac" ? "mac-mlx" : "windows-llamacpp";
  if (team.preset !== preset || teamUsesSetup(team, setup)) return false;
  await applyTeamPreset(preset, undefined, localSwapUrl(setup));
  clearProbeCache();
  return true;
}

/** Whether the Brain team asks this computer's llama-swap for exactly the models it serves. */
export function teamUsesSetup(team: TeamConfig, config: SetupConfig): boolean {
  const served = new Set(setupRoles(config).map((r) => config.models[r]!.name));
  const url = localSwapUrl(config);
  const roles = team.checkerSameAsHead ? (["head", "executor"] as const) : (["head", "executor", "checker"] as const);
  return roles.every((r) => {
    const e = team.roles[r].primary;
    return served.has(e.model) && (e.baseUrl ?? "").replace("localhost", "127.0.0.1").replace(/\/+$/, "") === url;
  });
}

/** Puts the models found on this computer into the settings. */
function applyPicks(config: SetupConfig, picked: Picks): void {
  for (const role of ["head", "executor", "checker"] as const) {
    const found = picked[role];
    const model = config.models[role];
    if (found && model) model.source = found;
  }
}

/** The models with each role that's still on its default download switched to the matching file
 * found here, or null when nothing changes. A source the user set themselves is left alone. */
export function useLocalCopies(config: SetupConfig, picked: Picks): SetupConfig["models"] | null {
  const defaults = DEFAULT_MODELS[config.computer];
  const next = structuredClone(config.models);
  let changed = false;
  for (const role of ["head", "executor", "checker"] as const) {
    const model = next[role];
    const found = picked[role];
    if (model && found && model.source === defaults[role]?.source) {
      model.source = found;
      changed = true;
    }
  }
  return changed ? next : null;
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

/** Where to look for models and llama.cpp builds already on this computer (under the home folder):
 * Bonsai-demo, Mimir's own folders, llama.cpp's -hf download cache, the Hugging Face cache, LM
 * Studio's models, winget's llama.cpp, and the usual places people save things. */
const SEARCH_ROOTS = [
  "Bonsai-demo",
  path.join(".mimir", "models"),
  path.join(".mimir", "bin"),
  "models",
  "llama.cpp",
  path.join("AppData", "Local", "llama.cpp"),
  path.join("Library", "Caches", "llama.cpp"),
  path.join(".cache", "llama.cpp"),
  path.join(".cache", "huggingface", "hub"),
  path.join(".lmstudio", "models"),
  path.join("AppData", "Local", "Microsoft", "WinGet", "Links"),
  path.join("AppData", "Local", "Microsoft", "WinGet", "Packages"),
  "Downloads",
  "Documents",
  "Desktop"
];

type Found = { models: Array<{ path: string; bytes: number }>; servers: string[] };

/** .gguf models and llama-server programs in the usual folders and any added in Settings. */
export async function findLocal(home = os.homedir(), extraDirs: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<Found> {
  const models: Array<{ path: string; bytes: number }> = [];
  const servers: string[] = [];
  const seen = new Set<string>();
  let budget = 80_000;
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
        if (!/^(node_modules|\.git|\.venv|venv|__pycache__|blobs|\.Trash)$/.test(e.name)) await walk(full, depth + 1);
      } else if (/\.gguf$/i.test(e.name) && !/mmproj/i.test(e.name)) {
        try {
          // stat, not lstat: the Hugging Face cache keeps models as links to its blobs.
          models.push({ path: full, bytes: (await stat(full)).size });
        } catch {
          /* gone, or a broken link */
        }
      } else if (e.name === "llama-server" || e.name === "llama-server.exe") servers.push(full);
    }
  };
  const roots = [
    ...extraDirs,
    ...(env.LLAMA_CACHE ? [env.LLAMA_CACHE] : []),
    ...(env.HF_HUB_CACHE ? [env.HF_HUB_CACHE] : []),
    ...SEARCH_ROOTS.map((r) => path.join(home, r)),
    ...(process.platform === "win32" ? ["C:\\llama.cpp", "C:\\models", "C:\\AI"] : [])
  ];
  for (const root of roots) {
    const dir = path.resolve(root.replace(/^~(?=[\\/])/, home));
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    await walk(dir, 0);
  }
  return { models, servers };
}

export type Picks = { head: string | null; executor: string | null; checker: string | null };

/** The models to use from what's on this computer.
 * Mac: Qwen3.5-9B as Head (IQ3_XXS scored best in your benchmark, then IQ2_M), Bonsai 8B as Executor.
 * PC: Ternary Bonsai 2 27B as Head, Bonsai 8B as Executor, Qwen3.5-9B IQ3_XXS as Checker. */
export function pickModels(found: { models: Array<{ path: string }> }, computer: "mac" | "pc" = "mac"): Picks {
  const names = found.models.map((m) => m.path);
  const base = (p: string) => path.basename(p);
  const pq2First = (a: string, b: string) => Number(/PQ2/i.test(base(b))) - Number(/PQ2/i.test(base(a)));
  const executor = names.filter((p) => /bonsai/i.test(base(p)) && /8b/i.test(base(p)) && !/bonsai[-_ .]?2[-_ .]/i.test(base(p))).sort(pq2First)[0] ?? null;
  const rank = (p: string) => (/IQ3_XXS/i.test(p) ? 0 : /IQ2_M/i.test(p) ? 1 : /Q3/i.test(p) ? 2 : /Q4/i.test(p) ? 3 : 4);
  const qwen = names.filter((p) => /qwen3[._-]?5.*9b/i.test(base(p))).sort((a, b) => rank(base(a)) - rank(base(b)))[0] ?? null;
  if (computer === "mac") return { head: qwen, executor, checker: null };
  const big = names.filter((p) => /bonsai/i.test(base(p)) && /27b/i.test(base(p))).sort(pq2First)[0] ?? null;
  return { head: big, executor, checker: qwen };
}

/** The llama-server to run: the one chosen in Settings, else Bonsai-demo's build (it reads PQ2_0
 * files), else Mimir's own or one on PATH. */
async function findServer(config: SetupConfig): Promise<string | null> {
  if (config.serverPath && existsSync(config.serverPath)) return config.serverPath;
  const local = (await findLocal(os.homedir(), config.modelDirs)).servers;
  const prism = local.find(isPrismBuild);
  return prism ?? findCommand("llama-server") ?? local[0] ?? null;
}

/** A llama-server from PrismML's build (Mimir's own install or Bonsai-demo's), which reads PQ2_0. */
export function isPrismBuild(server: string): boolean {
  return server.includes(path.join(".mimir", "bin", "llama.cpp")) || server.includes("Bonsai-demo");
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
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, PATH: serverPath(process.env.PATH) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    const child = spawn(bin, ["--config", SWAP_CONFIG, "--listen", config.listen], { env: { ...process.env, PATH: serverPath(process.env.PATH) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill();
  }
}

export const swap = new SwapProcess();

/** The model names a running llama-swap lists. */
async function servedModels(url: string): Promise<string[]> {
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(2000) });
    return (((await res.json()) as { data?: Array<{ id?: string }> }).data ?? []).map((m) => m.id ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** A plain reading of the usual reasons a model server quits while loading. */
export function explainLoadFailure(output: string, source: string): string {
  if (/invalid ggml type|unknown (model )?type|unsupported.*type|failed to read gguf/i.test(output) && /PQ2|bonsai/i.test(source)) {
    return "This llama-server can't read Bonsai's PQ2_0 files: that needs PrismML's build of llama.cpp. Press Install on the llama.cpp step (or point llama-server at Bonsai-demo's).\n\n";
  }
  if (/out of memory|cudaMalloc failed|failed to allocate|CUDA error: out of memory/i.test(output)) {
    return "The GPU ran out of memory loading it: lower -c (context) in its arguments, or close other programs using the GPU.\n\n";
  }
  if (/error: (invalid argument|unknown argument)|unrecognized|invalid value/i.test(output)) {
    return "This llama-server doesn't understand one of the arguments (an older build?). Update llama.cpp, or remove that argument from the model's settings.\n\n";
  }
  if (/no such file|failed to open|cannot find/i.test(output)) {
    return "The model file wasn't found where the settings say: press Look again on the Models step.\n\n";
  }
  return "";
}

/** Closes a llama-swap Mimir didn't start (one left from before, or started by hand). */
async function stopOtherSwap(): Promise<void> {
  if (process.platform === "win32") await run("taskkill", ["/IM", "llama-swap.exe", "/T", "/F"], { timeoutMs: 15_000 });
  else await run("pkill", ["-x", "llama-swap"], { timeoutMs: 15_000 });
}

/** Why a model's server quit while loading: the end of llama-swap's output (which carries the
 * server's own), or, when that has nothing, the server's output from starting it once directly. */
async function whyServerExited(config: SetupConfig, role: "head" | "executor" | "checker"): Promise<string> {
  // Drop llama-swap's request log and health checks; keep what the servers said.
  const noise = /"(GET|POST) \/|GPU monitoring|listening on http|Health check passed|recording partial metrics/;
  const tail = (text: string) => text.trim().split(/\r?\n/).filter((l) => l.trim() && !noise.test(l)).slice(-20).join("\n");
  const fromSwap = tail(swap.output);
  if (fromSwap && /llama|error|failed|gguf|cuda/i.test(fromSwap)) return fromSwap;
  const server = await findServer(config);
  const model = config.models[role];
  if (!server || !model) return fromSwap;
  const source = isLocalModel(model.source) ? ["-m", model.source] : ["-hf", model.source];
  const args = [...source, "--host", "127.0.0.1", "--port", "18765", ...(model.args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])];
  const { output } = await run(server, args, { timeoutMs: 25_000 });
  return tail(output) || fromSwap;
}

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

/** Each model's layers and how many go on the GPU at the configured share (read from the model's
 * file when it's here, else typical for its size). */
export function splitsFor(config: SetupConfig): Partial<Record<"head" | "executor" | "checker", LayerSplit>> {
  return Object.fromEntries(setupRoles(config).map((r) => [r, layerSplit(config.models[r]!.source, config.gpuShare)]));
}

/** The llama-swap config with this computer's GPU share applied. */
const yamlFor = (config: SetupConfig, server: string) => swapYaml(config, server, splitsFor(config));

/** The steps for this computer and how far along each one is. */
export async function setupView(): Promise<SetupView> {
  let config = await loadSetupConfig();
  const mac = config.computer === "mac";
  const found = await findLocal(os.homedir(), config.modelDirs);
  // A role still on its default download uses the same model when it's already on this computer
  // (e.g. Bonsai-demo's setup fetched it), instead of downloading it again.
  const local = useLocalCopies(config, pickModels(found, config.computer));
  if (local) config = await saveSetupConfig({ models: local });
  const server = await findServer(config);
  const yaml = yamlFor(config, server ?? "llama-server");
  const written = await fileText(SWAP_CONFIG);
  const up = await answers(localSwapUrl(config));
  // What a running llama-swap serves, against what these settings list (an old one may still run).
  const serving = up ? await servedModels(localSwapUrl(config)) : [];
  // Stale: it serves other models, or Mimir's llama-swap runs a list written before the settings
  // changed (another llama-server, other files or arguments).
  const stale = up && (setupRoles(config).some((r) => !serving.includes(config.models[r]!.name)) || (swap.running && written !== null && written !== yaml));
  const wrongKind = (config.computer === "mac") !== (process.platform === "darwin");
  const team = await loadTeamConfig();
  const teamInUse = team.preset === "mac-with-pc" || teamUsesSetup(team, config);
  const preset = mac ? "mac-mlx" : "windows-llamacpp";
  const step = (s: Omit<SetupStep, "note"> & { note?: string }): SetupStep => ({ note: "", ...s });
  const has = (name: string) => findCommand(name) !== null;
  const roles = setupRoles(config);
  const ready = roles.filter((r) => modelCached(config.models[r]!.source));
  const needsPrism = roles.some((r) => /PQ2/i.test(config.models[r]!.source));

  const steps: SetupStep[] = [
    step({
      id: "llama.cpp",
      title: mac ? "llama.cpp (Bonsai's build)" : "llama.cpp (Bonsai's CUDA build)",
      detail: mac
        ? "llama-server runs the models on the Mac's GPU. PrismML's build reads Ternary Bonsai's PQ2_0 files; Mimir uses the one in ~/Bonsai-demo when it's there."
        : "llama-server for the NVIDIA card. Bonsai's PQ2_0 files need PrismML's build of llama.cpp: Install gets its CUDA version and runtime into ~/.mimir/bin. Needs a current NVIDIA driver.",
      command: mac ? "cd ~/Bonsai-demo && ./setup.sh" : "Or set the path of a llama-server.exe from PrismML's build below",
      action: process.platform === "darwin" || process.platform === "win32" ? (!server ? "Install" : needsPrism && !isPrismBuild(server) ? "Install Bonsai's build" : "Update") : null,
      state: server ? (needsPrism && !isPrismBuild(server) ? "error" : "done") : "todo",
      note: server
        ? needsPrism && !isPrismBuild(server)
          ? `Found ${server}, but that looks like stock llama.cpp, which can't load Bonsai's PQ2_0 files. Press Install to get PrismML's build (it's used instead automatically).`
          : `Using ${server}`
        : ""
    }),
    step({
      id: "models",
      title: "Models",
      detail: mac
        ? "Qwen3.5-9B IQ3_XXS plans and checks; Ternary Bonsai 8B (PQ2_0) does the tool steps. Files already on this Mac are used as they are, nothing is copied."
        : "Ternary Bonsai 2 27B plans and writes, Ternary Bonsai 8B does the tool steps, Qwen3.5-9B IQ3_XXS checks them. Files already on this PC are used as they are; anything missing downloads the first time it starts. Add a folder below if yours are somewhere else.",
      command: null,
      action: "Look again",
      state: wrongKind ? "error" : ready.length === roles.length ? "done" : "todo",
      note: (wrongKind ? `These settings are for ${mac ? "a Mac" : "the Windows PC"}, but this computer is ${process.platform === "darwin" ? "a Mac" : "not a Mac"}: pick “${process.platform === "darwin" ? "Mac" : "Windows PC"}” at the top.\n` : "") + roles.map((r) => `${ROLE_NAMES[r]} · ${config.models[r]!.name}: ${modelCached(config.models[r]!.source) ? config.models[r]!.source : `${config.models[r]!.source} (not found on this computer; downloaded on first start)`}`).join("\n") + sharedNames(config).map((t) => `\n${t}`).join("")
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
      action: stale ? "Restart" : swap.running ? "Stop" : up ? null : "Start",
      state: stale ? "error" : up ? "done" : "todo",
      note: stale
        ? setupRoles(config).some((r) => !serving.includes(config.models[r]!.name))
          ? `The llama-swap running now serves ${serving.join(", ") || "nothing"}, an old model list. Restart loads the one above${swap.running ? "" : " (it closes the llama-swap that's running now)"}.`
          : "These settings changed since llama-swap started (llama-server, model files or arguments). Restart to use them."
        : up && !swap.running
          ? "Something is already answering on this port (llama-swap started elsewhere?)."
          : ""
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
      action: teamInUse ? null : "Use them",
      state: teamInUse ? "done" : team.preset === preset ? "error" : "todo",
      note: !teamInUse && team.preset === preset ? "The Brain team still asks for models llama-swap doesn't have (from before these settings changed). Press Use them." : ""
    })
  ];
  return {
    config,
    found,
    server,
    memory: { availableBytes: await availableMemory(), totalBytes: os.totalmem() },
    gpus: await gpuInfo(),
    splits: Object.fromEntries(
      Object.entries(splitsFor(config)).map(([role, split]) => {
        const source = config.models[role as "head"]!.source;
        const file = modelFile(source);
        let bytes: number | null;
        try {
          bytes = file ? statSync(file).size : null;
        } catch {
          bytes = null;
        }
        const need = memoryNeeded(source, bytes);
        const gpuBytes = (need * split!.onGpu) / split!.layers;
        return [role, { ...split!, gpuBytes, cpuBytes: need - gpuBytes, moe: isMoe(source) }];
      })
    ),
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
      // The model list names the llama-server to run: write it again so the new build is used.
      await runSetupStep("config");
      if (wasRunning) swap.start(config);
      return `${message} The model list now uses ${(await findServer(config)) ?? "llama-server"}.`;
    }
    case "models": {
      const found = await findLocal(os.homedir(), config.modelDirs);
      const picked = pickModels(found, config.computer);
      const next = structuredClone(config);
      applyPicks(next, picked);
      await saveSetupConfig({ models: next.models });
      const names = [picked.head, picked.executor, picked.checker].filter((p): p is string => !!p).map((p) => path.basename(p));
      return names.length
        ? `Found ${names.join(", ")} (${found.models.length} .gguf file${found.models.length === 1 ? "" : "s"} in all).`
        : `No matching .gguf files found (${found.models.length} other .gguf file${found.models.length === 1 ? "" : "s"}). Add the folder they're in below, or they download on first start.`;
    }
    case "config": {
      const server = await findServer(config);
      await mkdir(path.dirname(SWAP_CONFIG), { recursive: true });
      await writeFile(SWAP_CONFIG, yamlFor(config, server ?? "llama-server"), "utf-8");
      return server ? `Wrote ${SWAP_CONFIG}.` : `Wrote ${SWAP_CONFIG}, but llama-server isn't installed yet.`;
    }
    case "start": {
      const url0 = localSwapUrl(config);
      const running = (await answers(url0)) ? await servedModels(url0) : null;
      const outdated =
        running !== null &&
        (setupRoles(config).some((r) => !running.includes(config.models[r]!.name)) ||
          (swap.running && (await fileText(SWAP_CONFIG)) !== yamlFor(config, (await findServer(config)) ?? "llama-server")));
      if (outdated) {
        // Restart: stop Mimir's llama-swap, or close one started some other way.
        if (swap.running) swap.stop();
        else await stopOtherSwap();
        for (let i = 0; i < 20 && (await answers(url0)); i++) await new Promise((r) => setTimeout(r, 500));
      } else if (swap.running) {
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
      for (const role of [...setupRoles(config)].reverse()) {
        const name = config.models[role]!.name;
        if (config.computer === "mac") await checkRoom(config, name);
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: name, messages: [{ role: "user", content: "Say ok." }], max_tokens: 4, chat_template_kwargs: { enable_thinking: false } }),
          signal: AbortSignal.timeout(45 * 60_000)
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 400);
          const why = /exited prematurely|exited|upstream/i.test(body) ? await whyServerExited(config, role) : "";
          throw new Error(`${name} didn't load (${res.status}): ${body}${why ? `\n\n${explainLoadFailure(why, config.models[role]!.source)}What llama-server said:\n${why}` : ""}`);
        }
        done.push(name);
      }
      return `Loaded ${done.join(" and ")}.`;
    }
    case "tune":
      return tuneGpuShare(config);
    case "team": {
      await applyTeamPreset(config.computer === "mac" ? "mac-mlx" : "windows-llamacpp", undefined, localSwapUrl(config));
      clearProbeCache();
      return "The Brain team now uses these models.";
    }
    default:
      throw new Error(`No setup step called ${id}`);
  }
}

let tuning = false;

/** Restarts llama-swap with the model list for `config` and waits for it to answer. */
async function restartSwap(config: SetupConfig): Promise<void> {
  const server = await findServer(config);
  await writeFile(SWAP_CONFIG, yamlFor(config, server ?? "llama-server"), "utf-8");
  if (swap.running) swap.stop();
  else await stopOtherSwap();
  const url = localSwapUrl(config);
  for (let i = 0; i < 20 && (await answers(url)); i++) await new Promise((r) => setTimeout(r, 500));
  swap.start(config);
  for (let i = 0; i < 40 && swap.running; i++) {
    if (await answers(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-swap didn't come up: ${swap.output.trim().slice(-300) || "no output"}`);
}

/** Auto-tune: loads the main model at a few GPU shares, times an answer at each, and keeps the
 * fastest that leaves graphics memory some room. Tries less GPU only while it isn't much slower. */
async function tuneGpuShare(start: SetupConfig): Promise<string> {
  if (start.computer === "mac") return "On a Mac the GPU shares the computer's memory, so the whole model stays on it: nothing to tune.";
  if (!(await gpuInfo()).some((g) => !g.shared)) throw new Error("No graphics card with its own memory was found, so there's nothing to tune.");
  const role = setupRoles(start).includes("executor") ? "executor" : setupRoles(start)[0];
  if (!role) throw new Error("Pick the models first.");
  const name = start.models[role]!.name;
  if (tuning) throw new Error("Already tuning.");
  tuning = true;
  const results: TuneResult[] = [];
  try {
    logActivity(`Auto-tune: timing ${name} at different GPU shares.`);
    for (const share of TUNE_SHARES) {
      const config = await saveSetupConfig({ gpuShare: share });
      try {
        await restartSwap(config);
        const ask = () =>
          fetch(`${localSwapUrl(config)}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: name, messages: [{ role: "user", content: "Count from 1 to 60, separated by commas." }], max_tokens: 96, temperature: 0, chat_template_kwargs: { enable_thinking: false } }),
            signal: AbortSignal.timeout(10 * 60_000)
          });
        // The first answer includes loading the model; time the second.
        const first = await ask();
        if (!first.ok) throw new Error(`didn't load (${first.status})`);
        await first.text();
        const began = Date.now();
        const res = await ask();
        if (!res.ok) throw new Error(`didn't answer (${res.status})`);
        const speed = tokensPerSecond(await res.json(), Date.now() - began);
        const vram = (await gpuInfo()).filter((g) => !g.shared && g.usedBytes !== null).map((g) => Math.round((g.usedBytes! * 100) / g.totalBytes));
        results.push({ share, tokensPerSecond: speed, vramPercent: vram.length ? Math.max(...vram) : null });
        logActivity(`Auto-tune: ${share}% GPU → ${speed === null ? "?" : speed.toFixed(1)} tokens/s, graphics memory ${vram.length ? `${Math.max(...vram)}%` : "?"} full.`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({ share, tokensPerSecond: null, vramPercent: null, error });
        logActivity(`Auto-tune: ${share}% GPU failed (${error}).`);
      }
      if (!keepTuning(results)) break;
    }
    const best = pickShare(results);
    const final = await saveSetupConfig({ gpuShare: best?.share ?? start.gpuShare });
    await restartSwap(final).catch(() => undefined);
    clearProbeCache();
    const table = results.map((r) => `${r.share}% GPU: ${r.error ? r.error : `${r.tokensPerSecond?.toFixed(1) ?? "?"} tokens/s${r.vramPercent === null ? "" : `, VRAM ${r.vramPercent}% full`}`}`).join("\n");
    const message = best
      ? `Kept ${best.share}% on the GPU for ${name} (${best.tokensPerSecond!.toFixed(1)} tokens/s).\n${table}`
      : `None of the shares worked well, so the GPU share stays at ${start.gpuShare}%.\n${table}`;
    logActivity(`Auto-tune: ${message.split("\n")[0]}`);
    return message;
  } finally {
    tuning = false;
  }
}

/** At startup: run llama-swap when asked to and nothing answers on its port yet. */
export async function autostartSwap(): Promise<void> {
  const config = await loadSetupConfig();
  // Only once llama-swap has been set up here (the config step has run at least once).
  if (!config.autostart || !existsSync(SWAP_CONFIG) || !findCommand("llama-swap")) return;
  const url = localSwapUrl(config);
  if (await answers(url)) {
    const serving = await servedModels(url);
    if (setupRoles(config).every((r) => serving.includes(config.models[r]!.name))) return;
  }
  // Nothing running, or an old llama-swap (left from an earlier Mimir) serving another model list:
  // the start step writes the list for these settings, closes the old one and starts this one.
  try {
    await runSetupStep("start");
    clearProbeCache();
  } catch {
    /* shown in Settings → Model servers */
  }
}

/** Unloads every model on Mimir's llama-swap (its /unload), when the setting is on. */
async function unloadIdleModels(): Promise<void> {
  if (tuning) return;
  const config = await loadSetupConfig();
  if (!config.unloadWhenDone) return;
  const url = localSwapUrl(config);
  if (!swap.running && !(await answers(url))) return;
  const running = await fetch(`${url}/running`, { signal: AbortSignal.timeout(2000) })
    .then(async (r) => ((await r.json()) as { running?: unknown[] }).running?.length ?? 0)
    .catch(() => 0);
  if (!running) return;
  await fetch(`${url}/unload`, { signal: AbortSignal.timeout(10_000) });
}

let watching: NodeJS.Timeout | null = null;

/** The load watch (setup/adaptive.ts): while Mimir's llama-swap runs, every 5 s, eases off the GPU
 * when the computer stays under pressure. Started once, when Mimir starts. */
export function startLoadWatch(): void {
  if (watching) return;
  setIdleUnloader(unloadIdleModels);
  let expected = Date.now() + 5000;
  let strained = 0;
  let restartPending = false;
  watching = setInterval(() => {
    const lagMs = Math.max(0, Date.now() - expected);
    expected = Date.now() + 5000;
    void (async () => {
      if (!swap.running || tuning) {
        strained = 0;
        return;
      }
      const config = await loadSetupConfig();
      if (restartPending && modelIdleFor() > 10_000) {
        restartPending = false;
        const server = await findServer(config);
        await writeFile(SWAP_CONFIG, yamlFor(config, server ?? "llama-server"), "utf-8");
        swap.stop();
        await new Promise((r) => setTimeout(r, 1500));
        swap.start(config);
        logActivity(`Restarted llama-swap with ${config.gpuShare}% of each model on the GPU.`);
        return;
      }
      if (config.computer === "mac") return; // the Mac's GPU shares its memory: nothing to move
      const vram = (await gpuInfo()).filter((g) => !g.shared && g.usedBytes !== null).map((g) => Math.round((g.usedBytes! * 100) / g.totalBytes));
      const ramPercent = Math.round(((os.totalmem() - (await availableMemory())) * 100) / os.totalmem());
      const why = underPressure({ vramPercent: vram.length ? Math.max(...vram) : null, ramPercent, lagMs });
      strained = why ? strained + 1 : 0;
      if (!why || strained < 3) return;
      strained = 0;
      const next = lowerShare(config.gpuShare);
      if (next === null) {
        logActivity(`Under pressure (${why}) with the GPU share already at its lowest (${config.gpuShare}%).`);
        return;
      }
      await saveSetupConfig({ gpuShare: next });
      restartPending = true;
      logActivity(`Under pressure (${why}): moving more of each model to the CPU, GPU share ${config.gpuShare}% → ${next}%. llama-swap restarts once no model is answering.`);
    })().catch((err) => logActivity(`Load watch: ${err instanceof Error ? err.message : String(err)}`));
  }, 5000);
  watching.unref();
}

/** Hermes refuses models with less than 64K tokens of context. On the PC, the Head is given that when
 * Hermes runs on the team's models (its 12 GB card can hold it; the 8 GB Mac can't, so it's left as
 * it is and "Test my AI setup" says so). A running llama-swap is restarted with it. Returns what
 * changed, or null. */
export async function makeHeadHermesReady(team: TeamConfig): Promise<string | null> {
  if (team.engine !== "hermes" || team.engineModels !== "team" || team.mode !== "team") return null;
  const config = await loadSetupConfig();
  if (config.computer !== "pc") return null;
  const head = config.models.head;
  const args = withContext(head.args, HERMES_CONTEXT);
  if (args === head.args) return null;
  await saveSetupConfig({ models: { ...config.models, head: { ...head, args } } });
  if (swap.running) await runSetupStep("start");
  return `The Head (${head.name}) now runs with 64K tokens of context, which Hermes needs.`;
}
