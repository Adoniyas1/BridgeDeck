import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LOG_DIR } from "../logs/turnLog.js";

/**
 * Easing off when the computer struggles: while a model is loaded, Mimir watches graphics memory,
 * RAM and its own responsiveness, and when the computer stays under pressure it moves more of each
 * model to the CPU (the GPU share goes down 10 points, not below FLOOR), then restarts llama-swap
 * once no model is answering. A frozen computer is BridgeDeck's safety stop's job: it stops the
 * models outright. What happens is written to ~/.mimir/logs/activity.log (BridgeDeck shows it).
 */

export const FLOOR = 40;
export const STEP = 10;

export type Pressure = { vramPercent: number | null; ramPercent: number; lagMs: number };

/** Under pressure: graphics memory or RAM nearly full, or Mimir itself stalling. */
export function underPressure(p: Pressure): string | null {
  if (p.vramPercent !== null && p.vramPercent >= 95) return `graphics memory ${p.vramPercent}% full`;
  if (p.ramPercent >= 90) return `RAM ${p.ramPercent}% full`;
  if (p.lagMs >= 1500) return `Mimir stalled for ${(p.lagMs / 1000).toFixed(1)} s`;
  return null;
}

/** The GPU share to move to, or null when it's already as low as it goes. */
export function lowerShare(current: number, floor = FLOOR): number | null {
  return current > floor ? Math.max(floor, current - STEP) : null;
}

// Model calls in progress, so llama-swap is only restarted between answers.
let inFlight = 0;
let lastCall = 0;
export function modelCallStarted(): void {
  inFlight++;
  lastCall = Date.now();
}
export function modelCallEnded(): void {
  inFlight = Math.max(0, inFlight - 1);
  lastCall = Date.now();
}
/** How long no model has been answering (0 while one is). */
export const modelIdleFor = (now = Date.now()): number => (inFlight > 0 ? 0 : now - lastCall);

export const ACTIVITY_LOG = path.join(LOG_DIR, "activity.log");

export function logActivity(message: string, file = ACTIVITY_LOG): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${message}\n`);
  } catch {
    /* nowhere to write it */
  }
}
