import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MIMIR_HOME } from "../config/store.js";
import type { SetupComputer } from "../../shared/types.js";

/**
 * Mimir's model library: models to download from Hugging Face, from a short list picked for each
 * computer or any GGUF repo, into ~/.mimir/models. Before downloading it says whether a model fits
 * (disk space, and memory or graphics memory); downloads show their progress and carry on where
 * they stopped (HTTP Range). A finished model can then be given to a role (setup/index.ts).
 *
 * A model's projector (mmproj, what lets it read pictures) is downloaded next to it, which is
 * where the llama-swap config looks for one (setup/plan.ts mmprojBeside).
 */

export const MODELS_DIR = path.join(MIMIR_HOME, "models");
const HF = "https://huggingface.co";
const GB = 1024 ** 3;

export interface CatalogModel {
  id: string;
  name: string;
  /** Hugging Face repo and the quant in its file names (as setup sources write them, repo:quant). */
  repo: string;
  quant: string;
  /** About how big, before the repo is asked (GB). */
  approxGb: number;
  computers: SetupComputer[];
  roles: Array<"head" | "executor" | "checker">;
  note: string;
  vision?: boolean;
}

/** Picked for an 8 GB Mac and a 12 GB-GPU, 16 GB-RAM PC (the models setup/plan.ts runs). */
export const CATALOG: CatalogModel[] = [
  { id: "qwen35-9b", name: "Qwen3.5 9B", repo: "unsloth/Qwen3.5-9B-GGUF", quant: "UD-IQ3_XXS", approxGb: 3.8, computers: ["mac", "pc"], roles: ["head", "checker"], vision: true, note: "The Mac's Head and the PC's Checker: smart for its size, reads pictures." },
  { id: "bonsai-8b", name: "Ternary Bonsai 8B", repo: "prism-ml/Ternary-Bonsai-8B-gguf", quant: "PQ2_0", approxGb: 2.3, computers: ["mac", "pc"], roles: ["executor"], note: "Fast and tiny; the Executor on both. Needs PrismML's llama.cpp (Setup installs it)." },
  { id: "bonsai2-27b", name: "Ternary Bonsai 2 27B", repo: "prism-ml/Ternary-Bonsai-2-27B-gguf", quant: "PQ2_0", approxGb: 8, computers: ["pc"], roles: ["head"], note: "The PC's Head: a 27B that fits on a 12 GB card. Needs PrismML's llama.cpp." },
  { id: "qwen35-35b-a3b", name: "Qwen3.5 35B-A3B", repo: "unsloth/Qwen3.5-35B-A3B-GGUF", quant: "Q4_K_M", approxGb: 20, computers: ["pc"], roles: ["head"], note: "Mixture of experts: smarter, and fast because only 3B are active, but its experts spill into RAM." }
];

export interface RepoFile {
  path: string;
  size: number;
}

type Fetch = typeof fetch;

/** The files in a repo (Hugging Face's tree API), only .gguf ones. */
export async function repoFiles(repo: string, fetchImpl: Fetch = fetch): Promise<RepoFile[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("A Hugging Face repo looks like owner/name.");
  const res = await fetchImpl(`${HF}/api/models/${repo}/tree/main?recursive=true`);
  if (res.status === 404 || res.status === 401) throw new Error(`No public repo called ${repo} on Hugging Face.`);
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}.`);
  const list = (await res.json()) as Array<{ type?: string; path?: string; size?: number; lfs?: { size?: number } }>;
  return list
    .filter((f) => f.type !== "directory" && typeof f.path === "string" && /\.gguf$/i.test(f.path))
    .map((f) => ({ path: f.path!, size: f.lfs?.size ?? f.size ?? 0 }));
}

const isProjector = (p: string) => /(^|\/)mmproj/i.test(p);

/** The model file for a quant (split files: the first part), and the repo's projector if it has
 * one (F16 preferred, else the smallest). */
export function pickFiles(files: RepoFile[], quant: string): { model: RepoFile[]; mmproj: RepoFile | null } {
  const q = quant.toLowerCase();
  const models = files.filter((f) => !isProjector(f.path) && path.posix.basename(f.path).toLowerCase().includes(q));
  // A model split in parts (…-00001-of-00003.gguf) needs every part; llama.cpp is given the first.
  const parts = models.filter((f) => /-\d{5}-of-\d{5}\.gguf$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const single = models.filter((f) => !/-\d{5}-of-\d{5}\.gguf$/i.test(f.path)).sort((a, b) => a.path.length - b.path.length)[0];
  const model = single ? [single] : parts;
  const projectors = files.filter((f) => isProjector(f.path));
  const mmproj = projectors.find((f) => /f16/i.test(f.path) && !/bf16/i.test(f.path)) ?? [...projectors].sort((a, b) => a.size - b.size)[0] ?? null;
  return { model, mmproj };
}

/** The quants a repo offers (for the picker), smallest first. */
export function quantsIn(files: RepoFile[]): Array<{ quant: string; bytes: number }> {
  const out = new Map<string, number>();
  for (const f of files) {
    if (isProjector(f.path)) continue;
    const m = /[-_.]((?:UD-)?(?:I?Q\d[\w]*|PQ\d[\w]*|F16|BF16|F32|TQ\d[\w]*))(?:-\d{5}-of-\d{5})?\.gguf$/i.exec(path.posix.basename(f.path));
    if (m?.[1]) out.set(m[1], (out.get(m[1]) ?? 0) + f.size);
  }
  return [...out].map(([quant, bytes]) => ({ quant, bytes })).sort((a, b) => a.bytes - b.bytes);
}

export interface Fit {
  ok: boolean;
  /** "fits", "tight" (it runs, slowly or with little else open) or "too big". */
  level: "fits" | "tight" | "too-big";
  detail: string;
}

/** Whether a model of `bytes` fits: disk first, then memory (the Mac shares its memory with the
 * GPU; the PC has the card's memory plus RAM for what spills over). */
export function fitFor(bytes: number, room: { disk: number; ram: number; vram: number; computer: SetupComputer }): Fit {
  const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;
  const need = bytes + 0.8 * GB;
  if (bytes > room.disk - 1 * GB) return { ok: false, level: "too-big", detail: `Needs ${gb(bytes)} of disk; ${gb(room.disk)} free.` };
  if (room.computer === "mac" || room.vram === 0) {
    // Leave about 2.5 GB for macOS and the apps.
    const usable = room.ram - 2.5 * GB;
    if (need <= usable * 0.85) return { ok: true, level: "fits", detail: `About ${gb(need)} loaded; this computer has ${gb(room.ram)}.` };
    if (need <= usable) return { ok: true, level: "tight", detail: `About ${gb(need)} loaded, close to the ${gb(room.ram)} here: close other apps while it runs.` };
    return { ok: false, level: "too-big", detail: `About ${gb(need)} loaded; this computer has ${gb(room.ram)}.` };
  }
  if (need <= room.vram * 0.9) return { ok: true, level: "fits", detail: `Fits on the graphics card (${gb(need)} of ${gb(room.vram)}).` };
  if (need <= room.vram + (room.ram - 4 * GB) * 0.8) return { ok: true, level: "tight", detail: `${gb(need)}: more than the card's ${gb(room.vram)}, so part runs from RAM (slower).` };
  return { ok: false, level: "too-big", detail: `About ${gb(need)}; the card has ${gb(room.vram)} and RAM ${gb(room.ram)}.` };
}

export async function freeDisk(dir = MODELS_DIR): Promise<number> {
  let at = dir;
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  const s = await statfs(at);
  return s.bavail * s.bsize;
}

/** Where a repo's file goes: one folder per repo, so its projector sits beside it. */
export function localPath(repo: string, file: string, dir = MODELS_DIR): string {
  return path.join(dir, repo.replace("/", "__"), path.posix.basename(file));
}

export interface Download {
  id: string;
  repo: string;
  /** The model file (the first part for split ones) that a role is given. */
  file: string;
  path: string;
  files: Array<{ url: string; path: string; size: number }>;
  done: number;
  total: number;
  status: "downloading" | "paused" | "done" | "error";
  error: string | null;
  /** Bytes per second, recently. */
  speed: number;
}

/** Downloads one file into `dest`, carrying on from `dest.part`. */
export async function fetchFile(url: string, dest: string, size: number, onBytes: (n: number) => void, signal: AbortSignal, fetchImpl: Fetch = fetch): Promise<void> {
  if (existsSync(dest) && (size <= 0 || (await stat(dest)).size === size)) { onBytes(size); return; }
  await mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const have = existsSync(part) ? (await stat(part)).size : 0;
  const res = await fetchImpl(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, redirect: "follow" });
  if (res.status === 416 && have > 0 && have === size) { await rename(part, dest); onBytes(size); return; }
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
  // 206: the server carries on from `have`; 200: it starts over.
  const resumed = res.status === 206 && have > 0;
  onBytes(resumed ? have : 0);
  let got = resumed ? have : 0;
  const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      got += value.byteLength;
      onBytes(got);
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  if (size > 0 && got !== size) throw new Error(`The download stopped early (${got} of ${size} bytes); start it again to carry on.`);
  await rename(part, dest);
}

/** Runs and remembers downloads (one at a time per file; the UI polls `list`). */
export class ModelDownloads {
  private jobs = new Map<string, Download>();
  private aborts = new Map<string, AbortController>();

  constructor(private fetchImpl: Fetch = fetch, private dir = MODELS_DIR) {}

  list(): Download[] {
    return [...this.jobs.values()];
  }

  /** Starts (or carries on) downloading a repo's quant, with its projector. */
  async start(repo: string, quant: string): Promise<Download> {
    const files = await repoFiles(repo, this.fetchImpl);
    const { model, mmproj } = pickFiles(files, quant);
    if (!model.length) throw new Error(`${repo} has no ${quant} .gguf file.`);
    const id = `${repo}:${quant}`;
    const running = this.jobs.get(id);
    if (running?.status === "downloading") return running;
    const all = [...model, ...(mmproj ? [mmproj] : [])];
    const job: Download = {
      id, repo,
      file: model[0]!.path,
      path: localPath(repo, model[0]!.path, this.dir),
      files: all.map((f) => ({ url: `${HF}/${repo}/resolve/main/${f.path.split("/").map(encodeURIComponent).join("/")}`, path: localPath(repo, f.path, this.dir), size: f.size })),
      done: 0,
      total: all.reduce((s, f) => s + f.size, 0),
      status: "downloading",
      error: null,
      speed: 0
    };
    this.jobs.set(id, job);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    void this.run(job, abort.signal);
    return job;
  }

  private async run(job: Download, signal: AbortSignal) {
    let before = 0;
    let mark = { t: Date.now(), bytes: 0 };
    try {
      for (const f of job.files) {
        await fetchFile(f.url, f.path, f.size, (n) => {
          job.done = before + n;
          const now = Date.now();
          if (now - mark.t >= 1000) { job.speed = Math.round(((job.done - mark.bytes) * 1000) / (now - mark.t)); mark = { t: now, bytes: job.done }; }
        }, signal, this.fetchImpl);
        before += f.size;
      }
      job.done = job.total;
      job.status = "done";
      job.speed = 0;
    } catch (err) {
      job.speed = 0;
      if (signal.aborted) job.status = "paused";
      else { job.status = "error"; job.error = err instanceof Error ? err.message : String(err); }
    } finally {
      this.aborts.delete(job.id);
    }
  }

  /** Pauses a download; what came is kept, and starting it again carries on. */
  pause(id: string): void {
    this.aborts.get(id)?.abort();
  }

  /** Stops a download and deletes its files, or deletes a downloaded model. */
  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id);
    this.aborts.get(id)?.abort();
    this.jobs.delete(id);
    if (!job) return;
    for (const f of job.files) {
      await rm(f.path, { force: true });
      await rm(`${f.path}.part`, { force: true });
    }
  }

  /** Models already in the folder (from before this run), shown as done. */
  async scan(): Promise<Array<{ repo: string; file: string; path: string; bytes: number }>> {
    const out: Array<{ repo: string; file: string; path: string; bytes: number }> = [];
    for (const folder of await readdir(this.dir).catch(() => [] as string[])) {
      const repo = folder.replace("__", "/");
      for (const file of await readdir(path.join(this.dir, folder)).catch(() => [] as string[])) {
        if (!/\.gguf$/i.test(file) || isProjector(file) || /-\d{5}-of-\d{5}\.gguf$/i.test(file) && !/-00001-of-/i.test(file)) continue;
        const full = path.join(this.dir, folder, file);
        out.push({ repo, file, path: full, bytes: (await stat(full)).size });
      }
    }
    return out;
  }
}

export const totalRam = () => os.totalmem();
