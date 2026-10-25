import os from "node:os";
import path from "node:path";
import type { SetupComputer } from "../../shared/types.js";
import { gpuInfo } from "../setup/gpu.js";
import { loadSetupConfig, runSetupStep, saveSetupConfig, swap, syncTeamWithSetup } from "../setup/index.js";
import { DEFAULT_MODELS } from "../setup/plan.js";
import { CATALOG, fitFor, freeDisk, ModelDownloads, quantsIn, repoFiles, type Download, type Fit } from "./library.js";

/** What the model library shows: the models picked for this computer (with whether each fits),
 * the downloads, and the models already downloaded and which role uses each. */

export const downloads = new ModelDownloads();

type Role = "head" | "executor" | "checker";

async function room(computer: SetupComputer) {
  const gpus = await gpuInfo().catch(() => []);
  const card = gpus.filter((g) => g.vendor !== "apple" && !g.shared).sort((a, b) => b.totalBytes - a.totalBytes)[0];
  return { disk: await freeDisk().catch(() => 0), ram: os.totalmem(), vram: computer === "pc" ? card?.totalBytes ?? 0 : 0, computer };
}

export interface LibraryView {
  computer: SetupComputer;
  room: { disk: number; ram: number; vram: number };
  catalog: Array<(typeof CATALOG)[number] & { fit: Fit; forThisComputer: boolean }>;
  downloads: Download[];
  local: Array<{ repo: string; file: string; path: string; bytes: number; roles: Role[] }>;
}

export async function libraryView(): Promise<LibraryView> {
  const config = await loadSetupConfig();
  const r = await room(config.computer);
  const local = await downloads.scan();
  const roles = (file: string): Role[] => (["head", "executor", "checker"] as const).filter((role) => config.models[role]?.source === file);
  return {
    computer: config.computer,
    room: { disk: r.disk, ram: r.ram, vram: r.vram },
    catalog: CATALOG.map((m) => ({ ...m, fit: fitFor(m.approxGb * 1024 ** 3, r), forThisComputer: m.computers.includes(config.computer) }))
      .sort((a, b) => Number(b.forThisComputer) - Number(a.forThisComputer)),
    downloads: downloads.list(),
    local: local.map((l) => ({ ...l, roles: roles(l.path) }))
  };
}

/** A repo's quants, each with whether it fits here. */
export async function repoQuants(repo: string): Promise<Array<{ quant: string; bytes: number; fit: Fit }>> {
  const config = await loadSetupConfig();
  const r = await room(config.computer);
  return quantsIn(await repoFiles(repo.trim())).map((q) => ({ ...q, fit: fitFor(q.bytes, r) }));
}

/** Gives a downloaded model to a role: the role keeps its name (so the Brain team still finds it)
 * and loads this file; the llama-swap config is rewritten, and a running llama-swap restarted. */
export async function useModel(file: string, role: Role): Promise<string> {
  if (!path.isAbsolute(file) || !/\.gguf$/i.test(file)) throw new Error("Pick a downloaded .gguf file.");
  const config = await loadSetupConfig();
  const current = config.models[role] ?? DEFAULT_MODELS[config.computer][role] ?? { ...DEFAULT_MODELS[config.computer].head, name: "checker" };
  const models = { ...config.models, [role]: { ...current, source: file } };
  await saveSetupConfig({ models });
  await syncTeamWithSetup();
  // "start" sees the old config file differs and restarts with the new one; writing it first would
  // make it look current, and "start" would stop llama-swap instead.
  await runSetupStep(swap.running ? "start" : "config");
  return `The ${role === "head" ? "Head" : role === "executor" ? "Executor" : "Checker"} now uses ${path.basename(file)}.`;
}
