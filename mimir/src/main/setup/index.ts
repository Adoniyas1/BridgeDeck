import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { MIMIR_HOME, readJsonFile, writeJsonFile } from "../config/store.js";
import { serverPath } from "../mcp/manager.js";
import { applyTeamPreset, loadTeamConfig } from "../team/config.js";
import { clearProbeCache } from "../team/endpoints.js";
import type { SetupConfig, SetupStep, SetupView } from "../../shared/types.js";
import { cleanSetupConfig, localSwapUrl, mergeSetupConfig, pickAssets, releaseTool, swapYaml, type ReleaseTool } from "./plan.js";

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
  return cleanSetupConfig(await readJsonFile<unknown>(FILE, {}));
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

/** The server program llama-swap starts for each model. */
const serverCommand = (config: SetupConfig) => (config.computer === "mac" ? "mlx_lm.server" : "llama-server");

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
  const server = findCommand(serverCommand(config));
  const yaml = swapYaml(config, server ?? serverCommand(config));
  const written = await fileText(SWAP_CONFIG);
  const up = await answers(localSwapUrl(config));
  const team = await loadTeamConfig();
  const preset = mac ? "mac-mlx" : "windows-llamacpp";
  const step = (s: Omit<SetupStep, "note"> & { note?: string }): SetupStep => ({ note: "", ...s });
  const has = (name: string) => findCommand(name) !== null;
  const cached = (["head", "executor"] as const).filter((r) => modelCached(config.models[r].source));

  const steps: SetupStep[] = [
    step({
      id: "llama-swap",
      title: "llama-swap",
      detail: "One address (port 8080) for both models; it starts each model's server when the team asks for it.",
      command: mac ? "brew tap mostlygeek/llama-swap && brew install llama-swap" : "Download llama-swap from github.com/mostlygeek/llama-swap/releases",
      action: has("llama-swap") ? "Update" : "Install",
      state: has("llama-swap") ? "done" : "todo"
    })
  ];
  if (mac) {
    steps.push(
      step({ id: "uv", title: "uv", detail: "Installs Python tools without touching the system Python.", command: "brew install uv", action: has("uv") ? null : "Install", state: has("uv") ? "done" : "todo" }),
      step({
        id: "mlx-lm",
        title: "MLX (mlx-lm)",
        detail: "Apple's model runtime for Apple silicon; mlx_lm.server serves a model over the OpenAI API.",
        command: "uv tool install --upgrade mlx-lm",
        action: has("mlx_lm.server") ? "Update" : "Install",
        state: has("mlx_lm.server") ? "done" : "todo"
      })
    );
  } else {
    steps.push(
      step({
        id: "llama.cpp",
        title: "llama.cpp (CUDA)",
        detail: "llama-server for the NVIDIA card: Mimir gets the CUDA build and its runtime from llama.cpp's releases. Needs a current NVIDIA driver.",
        command: "winget install llama.cpp   (Vulkan build: works, a bit slower)",
        action: process.platform === "win32" ? (has("llama-server") ? "Update" : "Install") : null,
        state: has("llama-server") ? "done" : "todo"
      })
    );
  }
  steps.push(
    step({
      id: "config",
      title: "Model list",
      detail: `Writes ${SWAP_CONFIG} with the two models below${config.keepBothLoaded ? ", kept loaded together" : ", taking turns in memory"}.`,
      command: null,
      action: written === yaml ? "Write again" : "Write it",
      state: written === yaml ? "done" : written ? "error" : "todo",
      note: written && written !== yaml ? "The file is out of date with these settings." : ""
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
      title: "Download and load the models",
      detail: `The first start downloads each model (${mac ? "about 2–5 GB each" : "about 20 GB for the Head, 6 GB for the Executor"}), then loads it. This sends each one a one-word message.${mac ? " On an 8 GB Mac, quit big apps first; if a model won't load, `sudo sysctl iogpu.wired_limit_mb=6144` lets the GPU use more memory (until restart)." : ""}`,
      command: null,
      action: up ? "Warm up" : null,
      state: cached.length === 2 ? "done" : "todo",
      note: cached.length === 1 ? `${config.models[cached[0]!].name} is downloaded.` : ""
    }),
    step({
      id: "team",
      title: "Use them for the Brain team",
      detail: `Applies the “${mac ? "This Mac (MLX)" : "This Windows PC (llama.cpp)"}” preset. To use the PC from the Mac, choose “This Mac, using the PC when it's on” in Brain team instead.`,
      command: null,
      action: team.preset === preset || team.preset === "mac-with-pc" ? null : "Use them",
      state: team.preset === preset || team.preset === "mac-with-pc" ? "done" : "todo"
    })
  );
  return { config, steps, yaml, configPath: SWAP_CONFIG, swapRunning: swap.running, swapLog: swap.output };
}

/** Does one step's action. Returns what happened, for the step's note. */
export async function runSetupStep(id: string): Promise<string> {
  const config = await loadSetupConfig();
  switch (id) {
    case "llama-swap":
    case "uv":
    case "llama.cpp": {
      const tool = releaseTool(id);
      if (!tool) throw new Error(`Mimir can't install ${id} on this computer; use the command shown.`);
      // A running program can't be replaced (on Windows); start it again afterwards.
      const wasRunning = swap.running && id !== "uv";
      if (wasRunning) swap.stop();
      const message = await installRelease(tool);
      if (wasRunning) swap.start(config);
      return message;
    }
    case "mlx-lm": {
      const uv = findCommand("uv");
      if (!uv) throw new Error("Install uv first.");
      const { code, output } = await run(uv, ["tool", "install", "--upgrade", "mlx-lm"]);
      if (code !== 0) throw new Error(`uv couldn't install mlx-lm: ${output.trim().slice(-500)}`);
      return output.trim().split("\n").slice(-2).join("\n") || "Installed mlx-lm.";
    }
    case "config": {
      const server = findCommand(serverCommand(config));
      await mkdir(path.dirname(SWAP_CONFIG), { recursive: true });
      await writeFile(SWAP_CONFIG, swapYaml(config, server ?? serverCommand(config)), "utf-8");
      return server ? `Wrote ${SWAP_CONFIG}.` : `Wrote ${SWAP_CONFIG}, but ${serverCommand(config)} isn't installed yet.`;
    }
    case "start": {
      if (swap.running) {
        swap.stop();
        return "Stopped llama-swap.";
      }
      if (!existsSync(SWAP_CONFIG)) await runSetupStep("config");
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
        const res = await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: name, messages: [{ role: "user", content: "Say ok." }], max_tokens: 4 }),
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
  if (await answers(localSwapUrl(config))) return;
  try {
    swap.start(config);
  } catch {
    /* shown in Settings → Model servers */
  }
}
