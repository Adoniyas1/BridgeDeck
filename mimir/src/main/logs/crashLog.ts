import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./turnLog.js";

/**
 * Mimir's crashes and stray errors, in ~/.mimir/logs/crash.log (BridgeDeck's Activity log shows it
 * too). An uncaught exception is written down before Mimir exits; a promise nobody caught is
 * written down and Mimir carries on. Written synchronously, so it's on disk even as the process dies.
 */

export const CRASH_LOG = path.join(LOG_DIR, "crash.log");
const MAX_BYTES = 512 * 1024;

export function recordCrash(kind: string, error: unknown, file = CRASH_LOG): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.old`);
    } catch {
      /* no log yet */
    }
    const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    const lines = text.split("\n").map((line, i) => (i ? `    ${line.trim()}` : line));
    appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${lines.join("\n")}\n`);
  } catch {
    /* nowhere to write it */
  }
}

let installed = false;

export function installCrashLog(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (error) => {
    recordCrash("crash", error);
    console.error(error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => recordCrash("error (unhandled promise)", reason));
}
