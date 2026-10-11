import path from "node:path";
import { readJsonFile, writeJsonFile } from "../config/store.js";
import { defaultProjectsRoot } from "../projects/paths.js";

/** Where the coding tools work (~/.mimir/coding.json); the Projects folder unless set. Per computer. */
const FILE = "coding.json";

export interface CodingConfig {
  /** An absolute folder, or null for the Projects folder. */
  root: string | null;
}

export async function loadCodingConfig(): Promise<CodingConfig> {
  const raw = await readJsonFile<CodingConfig>(FILE, { root: null });
  return { root: typeof raw.root === "string" && path.isAbsolute(raw.root) ? raw.root : null };
}

export async function saveCodingConfig(patch: Partial<CodingConfig>): Promise<CodingConfig> {
  const root = typeof patch.root === "string" && patch.root.trim() ? patch.root.trim() : null;
  if (root && !path.isAbsolute(root)) throw new Error("Give the folder's full path, e.g. /Users/you/code/project.");
  const next = { root };
  await writeJsonFile(FILE, next);
  return next;
}

export async function codingRoot(): Promise<string> {
  return (await loadCodingConfig()).root ?? defaultProjectsRoot();
}
