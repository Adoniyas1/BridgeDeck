import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** How fast each answer came (BridgeDeck charts it in Settings → Activity & safety): one line each,
 * tab-separated: time, model, tokens, tokens per second. Kept under SPEED_MAX bytes. */
export const SPEED_LOG = path.join(LOG_DIR, "speed.log");
const SPEED_MAX = 200 * 1024;

export function recordSpeed(model: string, tokens: number, ms: number, file = SPEED_LOG, now = new Date()): void {
  if (tokens < 8 || ms <= 0) return; // too short to say
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > SPEED_MAX) writeFileSync(file, readFileSync(file, "utf-8").split("\n").slice(-1000).join("\n"));
    } catch {
      /* no file yet */
    }
    appendFileSync(file, `${now.toISOString()}\t${model.replace(/\s+/g, " ").slice(0, 80)}\t${tokens}\t${((tokens * 1000) / ms).toFixed(1)}\n`);
  } catch {
    /* nowhere to write it */
  }
}

export function logActivity(message: string, file = ACTIVITY_LOG): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${message}\n`);
  } catch {
    /* nowhere to write it */
  }
}

/** Auto-tune: the GPU shares to try, most on the GPU first. */
export const TUNE_SHARES = [100, 90, 80, 70, 60, 50, 40];

export type TuneResult = { share: number; tokensPerSecond: number | null; vramPercent: number | null; error?: string };

/** How fast an answer came, from llama-server's own timings when it sends them, else the token count
 * over the time it took. */
export function tokensPerSecond(body: unknown, elapsedMs: number): number | null {
  const b = body as { timings?: { predicted_per_second?: number }; usage?: { completion_tokens?: number } } | null;
  const t = b?.timings?.predicted_per_second;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) return t;
  const n = b?.usage?.completion_tokens;
  return typeof n === "number" && n > 0 && elapsedMs > 0 ? (n * 1000) / elapsedMs : null;
}

/** The share to keep: the fastest one that loaded and left graphics memory some room (under 92%),
 * and among ones within 5% of that speed, the lowest (it leaves the most VRAM for everything else). */
export function pickShare(results: TuneResult[]): TuneResult | null {
  const fits = results.filter((r) => r.tokensPerSecond !== null && !r.error && (r.vramPercent === null || r.vramPercent < 92));
  if (!fits.length) return null;
  const best = Math.max(...fits.map((r) => r.tokensPerSecond!));
  return fits.filter((r) => r.tokensPerSecond! >= best * 0.95).sort((a, b) => a.share - b.share)[0] ?? null;
}

/** Whether to keep trying lower shares: stop once speed has clearly dropped off (under 60% of the
 * best so far), since less on the GPU only gets slower from there. */
export function keepTuning(results: TuneResult[]): boolean {
  const speeds = results.map((r) => r.tokensPerSecond).filter((s): s is number => s !== null);
  if (!speeds.length) return true;
  const last = results[results.length - 1]?.tokensPerSecond ?? null;
  return last === null || last >= Math.max(...speeds) * 0.6;
}
