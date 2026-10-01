// Immutable entry point. BridgeDeck starts Mimir with `node server-entry.mjs`. This file is never
// copied into the self-editable workspace (see COPY_INCLUDE in src/main/self-edit/workspace.ts) and
// no self-edit tool's path confinement allows writing here (tools only ever touch the workspace
// root). This is what makes "Mimir can rewrite its own core source" safe: the one file that decides
// *which* build to run can't be rewritten by the thing it's deciding about.
//
// Job: read ~/.mimir/active.json to find the most recently self-edited build. If it looks bootable
// AND the crash-loop counter is under budget, run it. Otherwise (or before any self-edit has
// happened) run this original build. Every start counts as an attempt; a build that comes up
// healthy (src/main/health.ts) resets the counter, so three starts in a row that never got healthy
// fall back to the original.

import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIMIR_HOME = path.join(os.homedir(), ".mimir");
const ACTIVE_FILE = path.join(MIMIR_HOME, "active.json");
const BOOT_ATTEMPTS_FILE = path.join(MIMIR_HOME, "boot-attempts.json");
const MAX_CONSECUTIVE_FAILURES = 3;
const ENTRY = path.join("dist", "main", "server.js");

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return fallback;
  }
}

async function resolveEntry() {
  await mkdir(MIMIR_HOME, { recursive: true });
  const attempts = await readJson(BOOT_ATTEMPTS_FILE, { consecutiveFailures: 0 });
  const failures = attempts.consecutiveFailures ?? 0;
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    console.warn(`[mimir] ${failures} consecutive failed boots — falling back to the original install.`);
    await writeFile(ACTIVE_FILE, JSON.stringify({ activeDir: null, revision: null, updatedAt: Date.now() }, null, 2));
    await writeFile(BOOT_ATTEMPTS_FILE, JSON.stringify({ consecutiveFailures: 0 }, null, 2));
    return path.join(APP_ROOT, ENTRY);
  }
  await writeFile(BOOT_ATTEMPTS_FILE, JSON.stringify({ consecutiveFailures: failures + 1 }, null, 2));

  const active = await readJson(ACTIVE_FILE, { activeDir: null });
  if (active.activeDir) {
    const candidate = path.join(active.activeDir, ENTRY);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(APP_ROOT, ENTRY);
}

process.env.MIMIR_APP_ROOT ||= APP_ROOT;
const entry = await resolveEntry();
await import(pathToFileURL(entry).href);
