import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import { readJsonFile } from "../config/store.js";
import { normalizeBaseUrl } from "../brain/baseUrl.js";
import type { RoleEndpoint, SetupConfig } from "../../shared/types.js";
import { cleanSetupConfig, isLocalModel, localSwapUrl, memoryNeeded } from "./plan.js";

/**
 * The memory guard: before a model on this Mac's llama-swap is loaded, check there's room for it,
 * and say what to close instead of letting macOS run out of memory (which froze and restarted the
 * 8 GB Mac). Only on macOS, where the GPU shares memory with everything else.
 */

const GB = 1024 ** 3;
const MARGIN = 0.6 * GB;
const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;

/** Memory that can be handed to a new model now: free, inactive (cache), speculative and
 * purgeable pages, from vm_stat. Elsewhere, Node's free memory. */
export async function availableMemory(platform = process.platform): Promise<number> {
  if (platform !== "darwin") return os.freemem();
  const out = await new Promise<string>((resolve) => execFile("vm_stat", { timeout: 3000 }, (err, stdout) => resolve(err ? "" : stdout)));
  return parseVmStat(out) ?? os.freemem();
}

export function parseVmStat(text: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!page) return null;
  const count = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  return (count("free") + count("inactive") + count("speculative") + count("purgeable")) * page;
}

const fileSize = (source: string) => {
  if (!isLocalModel(source)) return null;
  try {
    return statSync(source.replace(/^~(?=\/)/, os.homedir())).size;
  } catch {
    return null;
  }
};

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** What else is holding memory that the user could free: Ollama's loaded models. */
async function ollamaHolding(): Promise<string[]> {
  const ps = await getJson<{ models?: Array<{ name?: string; size?: number }> }>("http://127.0.0.1:11434/api/ps");
  return (ps?.models ?? []).filter((m) => m.name).map((m) => `Ollama is holding ${m.name} (${gb(m.size ?? 0)}): run “ollama stop ${m.name}”`);
}

/** Throws a clear error when `name` (one of the setup's models) won't fit right now. Models this
 * llama-swap already has loaded count as free when they'd be swapped out for this one. */
export async function checkRoom(config: SetupConfig, name: string, deps = { available: availableMemory, running: runningModels, ollama: ollamaHolding }): Promise<void> {
  const role = (["head", "executor"] as const).find((r) => config.models[r].name === name);
  if (!role) return;
  const running = await deps.running(config);
  if (running.includes(name)) return;
  const model = config.models[role];
  const need = memoryNeeded(model.source, fileSize(model.source));
  const reclaim = config.keepBothLoaded
    ? 0
    : running.reduce((sum, other) => {
        const r = (["head", "executor"] as const).find((x) => config.models[x].name === other);
        return r ? sum + memoryNeeded(config.models[r].source, fileSize(config.models[r].source)) : sum;
      }, 0);
  const available = (await deps.available()) + reclaim;
  if (available >= need + MARGIN) return;
  const tips = await deps.ollama();
  throw new Error(
    `Not enough free memory to load ${name}: it needs about ${gb(need)} and only ${gb(available)} is free. ` +
      `Mimir didn't load it, so the Mac doesn't run out of memory. Quit big apps (browsers, Xcode, games)${tips.length ? `; ${tips.join("; ")}` : ""}, then try again.`
  );
}

/** The models llama-swap has loaded right now. */
export async function runningModels(config: SetupConfig): Promise<string[]> {
  const data = await getJson<{ running?: Array<{ model?: string }> }>(`${localSwapUrl(config)}/running`);
  return (data?.running ?? []).map((r) => r.model).filter((m): m is string => typeof m === "string");
}

/** The memory guard for a chat turn: when `endpoint` is this Mac's llama-swap, checks there's room
 * for its model. Anything else (the PC, Ollama, the cloud) passes. */
export async function guardEndpoint(endpoint: Pick<RoleEndpoint, "provider" | "model" | "baseUrl">): Promise<void> {
  if (process.platform !== "darwin" || endpoint.provider !== "openai-compatible") return;
  const config = cleanSetupConfig(await readJsonFile<unknown>("setup.json", {}));
  if (config.computer !== "mac") return;
  const base = normalizeBaseUrl(endpoint.baseUrl)?.replace("localhost", "127.0.0.1");
  if (base !== localSwapUrl(config)) return;
  await checkRoom(config, endpoint.model);
}
