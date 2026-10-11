import type { SetupComputer, SetupConfig, SetupModel } from "../../shared/types.js";
import { MODELS } from "../team/config.js";

/**
 * What the model servers look like on each computer, as data: the default models, the llama-swap
 * config, and the GitHub release files Mimir installs. No I/O here (see setup/index.ts).
 *
 * Mac (8 GB): MLX models through mlx_lm.server, one loaded at a time (llama-swap swaps them).
 * PC (RTX 4070 Ti 12 GB, 16 GB RAM): llama.cpp's llama-server. Qwen3.5-35B-A3B's experts don't all
 * fit in VRAM, so some sit in system RAM (--n-cpu-moe); with only 16 GB of RAM it can't stay loaded
 * next to the 9B, so by default they take turns too.
 */

const model = (name: string, source: string, args: string): SetupModel => ({ name, source, args });

export const DEFAULT_MODELS: Record<SetupComputer, { head: SetupModel; executor: SetupModel }> = {
  mac: {
    head: model(MODELS.macHead, "mlx-community/Qwen3.5-9B-OptiQ-4bit", ""),
    executor: model(MODELS.macExecutor, "prism-ml/Ternary-Bonsai-8B-mlx-2bit", "")
  },
  pc: {
    head: model(MODELS.pcHead, "unsloth/Qwen3.5-35B-A3B-GGUF:UD-Q4_K_XL", "-c 32768 -ngl 99 --n-cpu-moe 24 --jinja"),
    executor: model(MODELS.pcExecutor, "unsloth/Qwen3.5-9B-GGUF:Q4_K_M", "-c 32768 -ngl 99 --jinja")
  }
};

export function defaultSetup(computer: SetupComputer): SetupConfig {
  return {
    computer,
    listen: computer === "mac" ? "127.0.0.1:8080" : "0.0.0.0:8080",
    autostart: false,
    keepBothLoaded: false,
    models: structuredClone(DEFAULT_MODELS[computer])
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
    source: /^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/.test(source) ? source : fallback.source,
    args: text(m.args, fallback.args, 500).replace(/[\r\n]+/g, " ")
  };
};

export function cleanSetupConfig(raw: unknown, platform: NodeJS.Platform = process.platform): SetupConfig {
  const c = (raw ?? {}) as Partial<SetupConfig>;
  const computer = c.computer === "mac" || c.computer === "pc" ? c.computer : computerFor(platform);
  const base = defaultSetup(computer);
  // Switching computer kind starts from that kind's models.
  const models = c.computer === computer ? c.models : undefined;
  return {
    computer,
    listen: typeof c.listen === "string" && /^[\w.[\]:-]+:\d{2,5}$/.test(c.listen.trim()) ? c.listen.trim() : base.listen,
    autostart: typeof c.autostart === "boolean" ? c.autostart : base.autostart,
    keepBothLoaded: typeof c.keepBothLoaded === "boolean" ? c.keepBothLoaded : base.keepBothLoaded,
    models: { head: cleanModel(models?.head, base.models.head), executor: cleanModel(models?.executor, base.models.executor) }
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

/** The llama-swap config for this computer. `server` is the mlx_lm.server (Mac) or llama-server
 * (PC) to run. */
export function swapYaml(config: SetupConfig, server: string): string {
  const lines = [
    "# Written by Mimir (Settings → Model servers). Change the models there; edits here are replaced.",
    "healthCheckTimeout: 1800 # the first start downloads the model",
    "startPort: 10001",
    "models:"
  ];
  for (const role of ["head", "executor"] as const) {
    const m = config.models[role];
    const cmd =
      config.computer === "mac"
        ? `${cmdPath(server)} --model ${m.source} --host 127.0.0.1 --port \${PORT}`
        : `${cmdPath(server)} -hf ${m.source} --host 127.0.0.1 --port \${PORT}`;
    lines.push(`  ${q(m.name)}:`, `    cmd: ${q(m.args ? `${cmd} ${m.args}` : cmd)}`);
    if (config.computer === "mac") lines.push(`    checkEndpoint: "/v1/models"`);
    // On the 8 GB Mac an idle model gives its memory back after 10 minutes.
    if (config.computer === "mac") lines.push("    ttl: 600");
  }
  if (config.keepBothLoaded) {
    lines.push("groups:", '  "team":', "    swap: false", "    exclusive: true", "    members:", ...(["head", "executor"] as const).map((r) => `      - ${q(config.models[r].name)}`));
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
  if (platform !== "win32") return null;
  // The CUDA build and its runtime DLLs: CUDA 12 runs on more drivers than 13.
  return {
    id,
    repo: "ggml-org/llama.cpp",
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
