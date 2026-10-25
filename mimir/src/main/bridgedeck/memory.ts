import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { BridgeDeckClient } from "./client.js";

/** BridgeDeck keeps Mimir's long-term memory as this note (Notes tab, folder "Mimir"). */
export const MEMORY_NOTE_ID = "mimir-memory";
/** What Mimir knows about the user (USER.md), kept as a note the same way. */
export const USER_NOTE_ID = "mimir-user";

interface SyncState { local: string; remote: string }

const hash = (text: string) => createHash("sha256").update(text.trim()).digest("hex");

export interface MemorySyncOptions {
  client: BridgeDeckClient;
  readMemory: () => Promise<string>;
  writeMemory: (markdown: string) => Promise<void>;
  /** Where the hashes from the last sync are kept. */
  statePath: string;
  /** Which note (default: Mimir's memory). */
  note?: { id: string; title: string };
}

/**
 * Keeps MEMORY.md and the "Mimir's memory" note the same, so the user can read
 * and edit what Mimir remembers (and see it on their other computer):
 * - only MEMORY.md changed (Mimir wrote it) → the note is replaced;
 * - the note changed (the user edited it) → MEMORY.md takes the note, even if
 *   both changed: the user's own edit wins.
 * Returns what happened, for logs and tests.
 */
export async function syncMemory(opts: MemorySyncOptions): Promise<"created" | "pushed" | "pulled" | "same"> {
  const local = await opts.readMemory();
  const state: SyncState | null = await readFile(opts.statePath, "utf-8").then((raw) => JSON.parse(raw) as SyncState).catch(() => null);
  const save = (next: SyncState) => writeFile(opts.statePath, JSON.stringify(next));
  const { id: NOTE, title } = opts.note ?? { id: MEMORY_NOTE_ID, title: "Mimir's memory" };
  let remote: string | null = null;
  try {
    remote = (await opts.client.call<{ markdown: string }>("notes/read", { id: NOTE })).markdown;
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("No such note")) throw error;
  }
  if (remote === null) {
    await opts.client.call("notes/create", { id: NOTE, title, folder: "Mimir", markdown: local });
    const stored = (await opts.client.call<{ markdown: string }>("notes/read", { id: NOTE })).markdown;
    await save({ local: hash(local), remote: hash(stored) });
    return "created";
  }
  const localChanged = !state || hash(local) !== state.local;
  const remoteChanged = !state || hash(remote) !== state.remote;
  if (remoteChanged && (state || hash(remote) !== hash(local))) {
    await opts.writeMemory(remote);
    await save({ local: hash(remote), remote: hash(remote) });
    return "pulled";
  }
  if (localChanged) {
    const pushed = await opts.client.call<{ markdown: string }>("notes/replace", { id: NOTE, markdown: local });
    await save({ local: hash(local), remote: hash(pushed.markdown) });
    return "pushed";
  }
  return "same";
}
