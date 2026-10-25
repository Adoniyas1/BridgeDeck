import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDef, ToolResult } from "../brain/Provider.js";
import { readJsonFile, writeJsonFile } from "../config/store.js";
import type { BridgeDeckClient } from "../bridgedeck/client.js";

/**
 * Mimir and the user's Obsidian vault. Two ways to have one:
 *
 * - **BridgeDeck's notes vault** (the default when BridgeDeck runs Mimir): every BridgeDeck note is
 *   already a Markdown file there, Mimir's memory and what it knows about the user included (the
 *   "Mimir's memory" and "About you (Mimir)" notes, bridgedeck/memory.ts). So Mimir only reads the
 *   vault, and saves new notes through BridgeDeck, which writes them out: no second copy.
 * - **A vault of its own** (a folder chosen in the Memory panel), kept as plain Markdown in `Mimir/`:
 *
 * - `Mimir/Memory.md` ↔ persona/MEMORY.md and `Mimir/About me.md` ↔ persona/USER.md, both ways:
 *   what Mimir writes shows up in Obsidian, and an edit made in Obsidian is what Mimir reads next
 *   (the user's edit wins when both changed);
 * - `Mimir/Daily/<date>.md`: Mimir's daily logs, copied one way (Mimir → vault);
 * - tools to search and read the whole vault, and to write new notes under `Mimir/Notes/`.
 *
 * Nothing outside `Mimir/` is ever written.
 */

const FILE = "obsidian.json";
export interface ObsidianConfig {
  vault: string | null;
  /** Use BridgeDeck's notes vault when there is one (the default). */
  useBridgeDeck?: boolean;
}

export const loadObsidianConfig = () => readJsonFile<ObsidianConfig>(FILE, { vault: null, useBridgeDeck: true });

/** The vault Mimir works with now: BridgeDeck's (when chosen and turned on there), else its own
 * folder, else none. A folder that is BridgeDeck's vault counts as BridgeDeck's. */
export async function resolveVault(config: ObsidianConfig, client: BridgeDeckClient | null): Promise<{ path: string; bridgedeck: boolean } | null> {
  const bd = client ? await client.call<{ enabled: boolean; path: string }>("vault").catch(() => null) : null;
  const bdPath = bd?.enabled && bd.path ? path.resolve(bd.path) : null;
  if (config.useBridgeDeck !== false && bdPath && existsSync(bdPath)) return { path: bdPath, bridgedeck: true };
  if (config.vault && existsSync(config.vault)) return { path: config.vault, bridgedeck: !!bdPath && path.resolve(config.vault) === bdPath };
  return null;
}

/** Sets the vault folder (an Obsidian vault has a `.obsidian` folder); null turns it off. */
export async function saveObsidianConfig(vault: string | null, useBridgeDeck = true): Promise<ObsidianConfig & { warning?: string }> {
  const clean = vault?.trim() ? path.resolve(vault.trim()) : null;
  if (clean && !existsSync(clean)) throw new Error("That folder doesn't exist.");
  await writeJsonFile(FILE, { vault: clean, useBridgeDeck });
  const warning = clean && !existsSync(path.join(clean, ".obsidian")) ? "That folder has no .obsidian folder: open it in Obsidian once (Open folder as vault) so it's a vault." : undefined;
  return { vault: clean, useBridgeDeck, ...(warning ? { warning } : {}) };
}

const hash = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");

/** The two files kept the same both ways: persona file → its name in the vault. */
export const SHARED_FILES: Array<[persona: string, vaultName: string]> = [["MEMORY.md", "Memory.md"], ["USER.md", "About me.md"]];

export interface ObsidianSyncOptions {
  vault: string;
  readPersona: (file: string) => Promise<string>;
  /** Saves a persona file (through Mimir's audited transaction). */
  writePersona: (file: string, text: string) => Promise<void>;
  /** Mimir's daily log folder. */
  dailyDir: string;
  /** Where the hashes from the last sync are kept. */
  statePath: string;
}

type State = Record<string, { local: string; vault: string }>;

/** One sync: returns what happened to each shared file ("pushed", "pulled", "same"), and how many
 * daily logs were copied. */
export async function syncObsidian(opts: ObsidianSyncOptions): Promise<{ files: Record<string, "pushed" | "pulled" | "same">; daily: number }> {
  const folder = path.join(opts.vault, "Mimir");
  await mkdir(path.join(folder, "Daily"), { recursive: true });
  const state: State = await readFile(opts.statePath, "utf-8").then((raw) => JSON.parse(raw) as State).catch(() => ({}));
  const files: Record<string, "pushed" | "pulled" | "same"> = {};
  for (const [persona, name] of SHARED_FILES) {
    const local = await opts.readPersona(persona);
    const vaultPath = path.join(folder, name);
    const inVault = await readFile(vaultPath, "utf-8").catch(() => null);
    const last = state[persona];
    if (inVault === null) {
      await writeFile(vaultPath, local);
      state[persona] = { local: hash(local), vault: hash(local) };
      files[persona] = "pushed";
      continue;
    }
    const vaultChanged = !last || hash(inVault) !== last.vault;
    const localChanged = !last || hash(local) !== last.local;
    if (hash(inVault) === hash(local)) {
      files[persona] = "same";
    } else if (vaultChanged) {
      // Edited in Obsidian: that's what Mimir knows now (the user's edit wins).
      await opts.writePersona(persona, inVault);
      files[persona] = "pulled";
    } else if (localChanged) {
      await writeFile(vaultPath, local);
      files[persona] = "pushed";
    } else files[persona] = "same";
    const now = files[persona] === "pulled" ? inVault : local;
    state[persona] = { local: hash(now), vault: hash(now) };
  }
  // Daily logs: copied when new or changed.
  let daily = 0;
  for (const name of await readdir(opts.dailyDir).catch(() => [] as string[])) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const text = await readFile(path.join(opts.dailyDir, name), "utf-8").catch(() => null);
    if (text === null) continue;
    const target = path.join(folder, "Daily", name);
    if ((await readFile(target, "utf-8").catch(() => null)) !== text) {
      await writeFile(target, text);
      daily++;
    }
  }
  await writeFile(opts.statePath, JSON.stringify(state));
  return { files, daily };
}

// ---- Tools: the vault as Mimir's long-term notes ----

const SKIP = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const MAX_FILES = 5000;

/** Every Markdown file in the vault (relative paths), at most MAX_FILES. */
async function notesIn(vault: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), r);
      else if (entry.name.toLowerCase().endsWith(".md")) out.push(r);
      if (out.length >= MAX_FILES) return;
    }
  }
  await walk(vault, "");
  return out;
}

/** A path inside the vault, or null when it would leave it. */
export function insideVault(vault: string, rel: string): string | null {
  const full = path.resolve(vault, rel);
  const root = path.resolve(vault);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/** Notes matching every word of the query (title words count double), best first. */
export async function searchVault(vault: string, query: string, limit = 8): Promise<Array<{ path: string; snippet: string }>> {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const hits: Array<{ path: string; snippet: string; score: number }> = [];
  for (const rel of await notesIn(vault)) {
    const full = path.join(vault, rel);
    if (((await stat(full).catch(() => null))?.size ?? Infinity) > 1_000_000) continue;
    const text = await readFile(full, "utf-8").catch(() => "");
    const lower = text.toLowerCase();
    const title = rel.toLowerCase();
    if (!words.every((w) => lower.includes(w) || title.includes(w))) continue;
    const score = words.reduce((s, w) => s + (title.includes(w) ? 2 : 0) + Math.min(5, lower.split(w).length - 1), 0);
    const at = Math.max(0, lower.indexOf(words[0] ?? "") - 80);
    hits.push({ path: rel, snippet: text.slice(at, at + 240).replace(/\s+/g, " ").trim(), score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ path: p, snippet }) => ({ path: p, snippet }));
}

/** A note title as a safe file name. */
const fileName = (title: string) => title.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "Note";

/** `client`: BridgeDeck, when the vault is its notes vault: new notes go through it (it writes the
 * file), so a note is never made behind its back. */
export function buildObsidianToolset(vault: string, client: BridgeDeckClient | null = null): { defs: ToolDef[]; handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>> } {
  const s = (description: string) => ({ type: "string", description });
  const defs: ToolDef[] = [
    { name: "obsidian_search", description: "Search the user's Obsidian vault (their own notes, and Mimir's notes under Mimir/) for notes containing the words. Returns paths and a snippet.", inputSchema: { type: "object", properties: { query: s("Words to find"), limit: { type: "number" } }, required: ["query"] } },
    { name: "obsidian_read", description: "Read one note from the user's Obsidian vault by its path (from obsidian_search).", inputSchema: { type: "object", properties: { path: s("The note's path in the vault, e.g. Classes/EE 310.md") }, required: ["path"] } },
    { name: "obsidian_write", description: "Save a note in the user's Obsidian vault under Mimir/Notes/ (for things worth keeping that are longer than a memory line: a summary, a plan, research). Replaces a Mimir note with the same title.", inputSchema: { type: "object", properties: { title: s("The note's title"), markdown: s("The note, in Markdown (Obsidian [[links]] welcome)") }, required: ["title", "markdown"] } }
  ];
  const ok = (content: string): ToolResult => ({ content });
  const fail = (content: string): ToolResult => ({ content, isError: true });
  const handlers = {
    obsidian_search: async (input: Record<string, unknown>) => {
      const hits = await searchVault(vault, String(input.query ?? ""), Math.min(20, Math.max(1, Number(input.limit) || 8)));
      return ok(hits.length ? hits.map((h) => `- ${h.path}: ${h.snippet}`).join("\n") : "No notes matched.");
    },
    obsidian_read: async (input: Record<string, unknown>) => {
      const full = insideVault(vault, String(input.path ?? ""));
      if (!full || !full.toLowerCase().endsWith(".md")) return fail("That isn't a note in the vault.");
      const text = await readFile(full, "utf-8").catch(() => null);
      return text === null ? fail("No such note.") : ok(text.slice(0, 100_000));
    },
    obsidian_write: async (input: Record<string, unknown>) => {
      const markdown = String(input.markdown ?? "");
      if (!markdown.trim()) return fail("The note is empty.");
      if (client) {
        const title = fileName(String(input.title ?? ""));
        await client.call("notes/create", { title, folder: "Mimir/Notes", markdown: markdown.slice(0, 200_000) });
        return ok(`Saved “${title}” in BridgeDeck's Notes (Mimir/Notes), which also puts it in the vault.`);
      }
      const dir = path.join(vault, "Mimir", "Notes");
      await mkdir(dir, { recursive: true });
      const name = `${fileName(String(input.title ?? ""))}.md`;
      await writeFile(path.join(dir, name), markdown.slice(0, 200_000));
      return ok(`Saved Mimir/Notes/${name} in the vault.`);
    }
  };
  return { defs, handlers };
}
