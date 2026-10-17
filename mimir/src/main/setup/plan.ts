import type { SetupComputer, SetupConfig, SetupModel } from "../../shared/types.js";
import { MODELS } from "../team/config.js";

/**
 * What the model servers look like on each computer, as data: the default models, the llama-swap
 * config, and the GitHub release files Mimir installs. No I/O here (see setup/index.ts).
 *
 * Mac (8 GB): small GGUF models through llama.cpp's llama-server (PrismML's build, which also
 * reads Ternary Bonsai's PQ2_0 files), one loaded at a time, a short context and a 4-bit KV cache,
 * the same settings that ran fast in the terminal. MLX's 4-bit 9B used to be the default here; it
 * needed 5–6 GB and ran the Mac out of memory.
 * PC (RTX 4070 Ti 12 GB, 16 GB RAM): llama.cpp's llama-server. Qwen3.5-35B-A3B's experts don't all
 * fit in VRAM, so some sit in system RAM (--n-cpu-moe); with only 16 GB of RAM it can't stay loaded
 * next to the 9B, so by default they take turns too.
 */

const model = (name: string, source: string, args: string): SetupModel => ({ name, source, args });

/** Settings that keep a model small in memory on the 8 GB Mac: 8K context, 4-bit KV cache. */
export const MAC_ARGS = "-c 8192 -ngl 99 -fa on -ctk q4_0 -ctv q4_0 --jinja";
/** On the PC (12 GB GPU): a 16K context and 4-bit KV cache keep the 27B on the card. */
export const PC_ARGS = "-c 16384 -ngl 99 -fa on -ctk q4_0 -ctv q4_0 --jinja";
/** 3: the PC runs Ternary Bonsai 2 27B, Bonsai 8B and Qwen3.5-9B, and a Checker model of its own. */
export const SETUP_VERSION = 3;

export const DEFAULT_MODELS: Record<SetupComputer, SetupConfig["models"]> = {
  mac: {
    head: model(MODELS.macHead, "unsloth/Qwen3.5-9B-GGUF:UD-IQ3_XXS", MAC_ARGS),
    executor: model(MODELS.macExecutor, "prism-ml/Ternary-Bonsai-8B-gguf:PQ2_0", MAC_ARGS),
    checker: null
  },
  pc: {
    head: model(MODELS.pcHead, "prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0", PC_ARGS),
    executor: model(MODELS.pcExecutor, "prism-ml/Ternary-Bonsai-8B-gguf:PQ2_0", PC_ARGS),
    checker: model(MODELS.pcChecker, "unsloth/Qwen3.5-9B-GGUF:UD-IQ3_XXS", PC_ARGS)
  }
};

export const IDLE_UNLOAD_SECS = 1200;

export function defaultSetup(computer: SetupComputer): SetupConfig {
  return {
    version: SETUP_VERSION,
    computer,
    serverPath: null,
    listen: computer === "mac" ? "127.0.0.1:8080" : "0.0.0.0:8080",
    autostart: false,
    keepBothLoaded: false,
    models: structuredClone(DEFAULT_MODELS[computer]),
    modelDirs: [],
    // The PC keeps a fifth of each model on the CPU, so the card isn't filled to the brim; the Mac's
    // GPU shares its memory, so there's nothing to gain there.
    gpuShare: computer === "mac" ? 100 : 80,
    // Unloaded as soon as Mimir is done with it, freeing RAM and VRAM; llama-swap's idle timer is a
    // backup for requests from anything else.
    unloadWhenDone: true,
    idleUnloadSecs: IDLE_UNLOAD_SECS
  };
}

export const computerFor = (platform: NodeJS.Platform): SetupComputer => (platform === "darwin" ? "mac" : "pc");

const cleanModel = (raw: unknown, fallback: SetupModel): SetupModel => {
  const m = (raw ?? {}) as Partial<SetupModel>;
  const text = (v: unknown, d: string, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : d);
  const name = text(m.name, fallback.name, 100);
  const source = text(m.source, fallback.source, 300);
  return {
    name: /^[\w.:-]+$/.test(name) ? name : fallback.name,
    source: isLocalModel(source) || /^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/.test(source) ? source : fallback.source,
    args: text(m.args, fallback.args, 500).replace(/[\r\n]+/g, " ")
  };
};

export function cleanSetupConfig(raw: unknown, platform: NodeJS.Platform = process.platform): SetupConfig {
  const c = (raw ?? {}) as Partial<SetupConfig>;
  const computer = c.computer === "mac" || c.computer === "pc" ? c.computer : computerFor(platform);
  const base = defaultSetup(computer);
  // Switching computer kind starts from that kind's models, and so does a Mac config from before
  // version 2 (its MLX models are what ran out of memory).
  const current = c.version === SETUP_VERSION;
  const models = c.computer === computer && current ? c.models : undefined;
  return {
    version: SETUP_VERSION,
    computer,
    serverPath: typeof c.serverPath === "string" && c.serverPath.trim() ? c.serverPath.trim().slice(0, 500) : null,
    listen: typeof c.listen === "string" && /^[\w.[\]:-]+:\d{2,5}$/.test(c.listen.trim()) ? c.listen.trim() : base.listen,
    autostart: typeof c.autostart === "boolean" ? c.autostart : base.autostart,
    keepBothLoaded: typeof c.keepBothLoaded === "boolean" ? c.keepBothLoaded : base.keepBothLoaded,
    models: {
      head: cleanModel(models?.head, base.models.head),
      executor: cleanModel(models?.executor, base.models.executor),
      checker: models && "checker" in models ? (models.checker ? cleanModel(models.checker, base.models.checker ?? base.models.head) : null) : base.models.checker
    },
    modelDirs: Array.isArray(c.modelDirs) ? c.modelDirs.filter((d): d is string => typeof d === "string" && d.trim().length > 0).map((d) => d.trim().slice(0, 500)).slice(0, 10) : [],
    gpuShare: typeof c.gpuShare === "number" && Number.isFinite(c.gpuShare) ? Math.round(Math.min(100, Math.max(0, c.gpuShare)) / 5) * 5 : base.gpuShare,
    unloadWhenDone: typeof c.unloadWhenDone === "boolean" ? c.unloadWhenDone : base.unloadWhenDone,
    idleUnloadSecs: typeof c.idleUnloadSecs === "number" && Number.isFinite(c.idleUnloadSecs) ? Math.round(Math.min(86_400, Math.max(0, c.idleUnloadSecs))) : base.idleUnloadSecs
  };
}

/** A change to the saved settings. Switching computer kind (and listen address, unless given)
 * starts from that kind's defaults. */
export function mergeSetupConfig(current: SetupConfig, patch: Partial<SetupConfig>): SetupConfig {
  if (patch.computer && patch.computer !== current.computer) {
    const fresh = defaultSetup(patch.computer);
    return cleanSetupConfig({ ...fresh, autostart: current.autostart, ...patch, models: { ...fresh.models, ...(patch.models ?? {}) } });
  }
  return cleanSetupConfig({ ...current, ...patch, models: { ...current.models, ...(patch.models ?? {}) } });
}

/** The roles that have a model of their own on this computer. */
export const setupRoles = (config: SetupConfig): Array<"head" | "executor" | "checker"> => (config.models.checker ? ["head", "executor", "checker"] : ["head", "executor"]);

/** A .gguf file on this computer (rather than a Hugging Face repo). */
export function isLocalModel(source: string): boolean {
  return /^(\/|~\/|[A-Za-z]:[\\/]).+\.gguf$/i.test(source);
}

/** About how much memory a model needs loaded: its file, plus room for the context and the
 * server. `fileBytes` is the file's size when it's on this computer. */
export function memoryNeeded(source: string, fileBytes: number | null): number {
  const GB = 1024 ** 3;
  const file = fileBytes ?? (/35b|30b/i.test(source) ? 20 : /27b/i.test(source) ? 8 : /PQ2|Bonsai/i.test(source) ? 2.3 : /IQ2|Q2/i.test(source) ? 3.3 : /IQ3|Q3/i.test(source) ? 3.8 : /9b|8b/i.test(source) ? 5.5 : 4) * GB;
  return file + 0.8 * GB;
}

/** The port llama-swap listens on, and the address to reach it from this computer. */
export function localSwapUrl(config: SetupConfig): string {
  const port = config.listen.split(":").pop();
  return `http://127.0.0.1:${port}`;
}

/** A path inside a llama-swap cmd: forward slashes (Windows takes them; backslashes would be read
 * as escapes) and quoted when it has spaces. */
export function cmdPath(p: string): string {
  const forward = p.replace(/\\/g, "/");
  return /\s/.test(forward) ? `'${forward}'` : forward;
}

const q = (s: string) => JSON.stringify(s);

/** How a model's layers split between the GPU and the CPU (from setup/gpu.ts). */
export type LayerSplit = { layers: number; onGpu: number; fromFile: boolean };

const NGL = /(^|\s)(-ngl|--n-gpu-layers|--gpu-layers)(\s+|=)(\d+|all|auto)\b/;

/** A mixture-of-experts model (e.g. Qwen3.5-35B-A3B: 35B in all, 3B used per word). */
export const isMoe = (source: string): boolean => /[-_]A\d+(\.\d+)?B\b|moe|mixtral/i.test(source);

const CPU_MOE = /(^|\s)--n-cpu-moe(\s+|=)(\d+)\b/;

/** A model's arguments with the GPU share applied: at 100 % they're left as they are. Below, an
 * ordinary model gets -ngl (that many layers on the GPU, the rest on the CPU), unless the arguments
 * already ask for fewer. A mixture-of-experts model instead keeps every layer on the GPU and puts
 * the experts of the other layers in RAM (--n-cpu-moe): every word uses only a few experts, so
 * that's much faster than running whole layers on the CPU. */
export function argsForShare(args: string, share: number, split: LayerSplit, moe = false): string {
  if (share >= 100) return args;
  if (moe) {
    const onCpu = split.layers - split.onGpu;
    const m = CPU_MOE.exec(args);
    if (m && Number(m[3]) >= onCpu) return args;
    return m ? args.replace(CPU_MOE, `$1--n-cpu-moe ${onCpu}`) : `${args} --n-cpu-moe ${onCpu}`.trim();
  }
  const m = NGL.exec(args);
  const current = m && /^\d+$/.test(m[4]!) ? Number(m[4]) : null;
  if (current !== null && current <= split.onGpu) return args;
  const flag = `-ngl ${split.onGpu}`;
  return m ? args.replace(NGL, `$1${flag}`) : `${args} ${flag}`.trim();
}


/** The llama-swap config for this computer. `server` is the llama-server to run; a model on this
 * computer is loaded with -m, one from Hugging Face with -hf (downloaded on first use). */
export function swapYaml(config: SetupConfig, server: string, splits: Partial<Record<"head" | "executor" | "checker", LayerSplit>> = {}): string {
  const lines = [
    "# Written by Mimir (Settings → Model servers). Change the models there; edits here are replaced.",
    "healthCheckTimeout: 1800 # the first start downloads the model",
    'logToStdout: "both" # pass each model server\'s own output on, so a failed load shows why',
    "startPort: 10001",
    "models:"
  ];
  for (const role of setupRoles(config)) {
    const m = config.models[role]!;
    const from = isLocalModel(m.source) ? `-m ${cmdPath(m.source)}` : `-hf ${m.source}`;
    const cmd = `${cmdPath(server)} ${from} --host 127.0.0.1 --port \${PORT}`;
    // Below 100 %, part of the model runs on the CPU (-ngl: how many layers go on the GPU).
    const split = splits[role];
    const args = split ? argsForShare(m.args, config.gpuShare, split, isMoe(m.source)) : m.args;
    lines.push(`  ${q(m.name)}:`, `    cmd: ${q(args ? `${cmd} ${args}` : cmd)}`);
    // An idle model gives its memory back (llama-swap's ttl: seconds without a request).
    if (config.idleUnloadSecs > 0) lines.push(`    ttl: ${config.idleUnloadSecs}`);
  }
  if (config.keepBothLoaded) {
    lines.push("groups:", '  "team":', "    swap: false", "    exclusive: true", "    members:", ...setupRoles(config).map((r) => `      - ${q(config.models[r]!.name)}`));
  }
  return `${lines.join("\n")}\n`;
}

/** A program Mimir can install from a project's GitHub releases. */
export interface ReleaseTool {
  id: "llama-swap" | "uv" | "llama.cpp";
  repo: string;
  /** Release files to download, in order; each list is tried pattern by pattern. */
  assets: RegExp[][];
  /** The files to keep (everything when null) and put in ~/.mimir/bin (or its subfolder). */
  files: string[] | null;
  subdir: string | null;
}

export function releaseTool(id: ReleaseTool["id"], platform: NodeJS.Platform = process.platform, arch: string = process.arch): ReleaseTool | null {
  const a = arch === "arm64" ? "arm64" : "amd64";
  if (id === "llama-swap") {
    const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
    return { id, repo: "mostlygeek/llama-swap", assets: [[new RegExp(`_${os}_${a}\\.(tar\\.gz|zip)$`)]], files: ["llama-swap", "llama-swap.exe"], subdir: null };
  }
  if (id === "uv") {
    const target = platform === "darwin" ? `${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin` : platform === "win32" ? "x86_64-pc-windows-msvc" : `${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
    return { id, repo: "astral-sh/uv", assets: [[new RegExp(`^uv-${target}\\.(tar\\.gz|zip)$`)]], files: ["uv", "uvx", "uv.exe", "uvx.exe"], subdir: null };
  }
  if (platform === "darwin") {
    // PrismML's build (the one Bonsai-demo downloads): stock llama.cpp can't read PQ2_0 files.
    return { id, repo: "PrismML-Eng/llama.cpp", assets: [[arch === "arm64" ? /-bin-macos-arm64\.(tar\.gz|zip)$/ : /-bin-macos-x64\.(tar\.gz|zip)$/]], files: null, subdir: "llama.cpp" };
  }
  if (platform !== "win32") return null;
  // PrismML's CUDA build (it reads PQ2_0 files, stock llama.cpp doesn't) and its runtime DLLs:
  // CUDA 12 runs on more drivers than 13.
  return {
    id,
    repo: "PrismML-Eng/llama.cpp",
    assets: [
      [/^llama-.*-bin-win-cuda-12\.\d+-x64\.zip$/, /^llama-.*-bin-win-cuda-13\.\d+-x64\.zip$/],
      [/^cudart-llama-bin-win-cuda-12\.\d+-x64\.zip$/, /^cudart-llama-bin-win-cuda-13\.\d+-x64\.zip$/]
    ],
    files: null,
    subdir: "llama.cpp"
  };
}

/** Picks the release files to download: for each group, the first pattern that matches; the
 * runtime must match the build's CUDA version. */
export function pickAssets<T extends { name: string }>(tool: ReleaseTool, assets: T[]): T[] {
  const picked: T[] = [];
  let cuda: string | null = null;
  for (const group of tool.assets) {
    let found: T | undefined;
    for (const pattern of group) {
      found = assets.find((x) => pattern.test(x.name) && (!cuda || x.name.includes(cuda)));
      if (found) break;
    }
    if (!found) throw new Error(`${tool.repo}'s latest release has no file for this computer (looked for ${group.map((p) => p.source).join(" or ")}).`);
    cuda ??= /cuda-\d+\.\d+/.exec(found.name)?.[0] ?? null;
    picked.push(found);
  }
  return picked;
}
