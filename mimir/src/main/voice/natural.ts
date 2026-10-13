import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { MIMIR_HOME } from "../config/store.js";

/**
 * Mimir's natural voice: Kokoro (82M), a small neural text-to-speech model that runs on this computer's
 * CPU through ONNX. No key and no account; the model (about 90 MB, 8-bit) downloads from Hugging Face
 * the first time and is kept in ~/.mimir/models/voice. The voices themselves ship with kokoro-js.
 */
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const VOICE_MODEL_DIR = path.join(MIMIR_HOME, "models", "voice");

/** The voices worth offering (Kokoro's best-graded ones), best first. */
export const NATURAL_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "af_heart", label: "Heart · American, female" },
  { id: "af_bella", label: "Bella · American, female" },
  { id: "af_nicole", label: "Nicole · American, female, soft" },
  { id: "am_michael", label: "Michael · American, male" },
  { id: "am_fenrir", label: "Fenrir · American, male" },
  { id: "am_puck", label: "Puck · American, male" },
  { id: "bf_emma", label: "Emma · British, female" },
  { id: "bm_george", label: "George · British, male" },
  { id: "bm_fable", label: "Fable · British, male" }
];
export const DEFAULT_NATURAL_VOICE = "af_heart";

export type NaturalVoiceState = "not-loaded" | "loading" | "ready" | "failed";

interface Synth {
  generate(text: string, opts: { voice: string; speed: number }): Promise<{ save(file: string): Promise<void> | void }>;
}

let synth: Synth | null = null;
let loading: Promise<Synth> | null = null;
let lastError: string | null = null;

export function naturalVoiceStatus(): { state: NaturalVoiceState; error: string | null } {
  return { state: synth ? "ready" : loading ? "loading" : lastError ? "failed" : "not-loaded", error: lastError };
}

/** Loads the model (downloading it the first time); the same promise while it's in progress. */
export function loadNaturalVoice(load: () => Promise<Synth> = loadKokoro): Promise<Synth> {
  if (synth) return Promise.resolve(synth);
  loading ??= load().then(
    (s) => {
      synth = s;
      lastError = null;
      loading = null;
      return s;
    },
    (err: unknown) => {
      loading = null;
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  );
  return loading;
}

async function loadKokoro(): Promise<Synth> {
  await mkdir(VOICE_MODEL_DIR, { recursive: true });
  // Keep the download with Mimir's data, not in node_modules (an update's `npm ci` would delete it).
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = VOICE_MODEL_DIR;
  const { KokoroTTS } = await import("kokoro-js");
  try {
    return (await KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" })) as unknown as Synth;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(/fetch|network|ENOTFOUND|ECONN|ETIMEDOUT/i.test(why) ? `couldn't download it from huggingface.co (${why}); check the internet connection and press Load again` : why, { cause: err });
  }
}

/** Speaks `text` in the natural voice into a WAV file and hands it to `play`; false when the model isn't
 * loaded yet (it starts loading, and the caller uses another voice for now). */
export async function speakNatural(text: string, voice: string, play: (file: string) => Promise<void>, speed = 1): Promise<boolean> {
  if (!synth) {
    void loadNaturalVoice().catch(() => undefined);
    return false;
  }
  const valid = NATURAL_VOICES.some((v) => v.id === voice) ? voice : DEFAULT_NATURAL_VOICE;
  const audio = await synth.generate(text, { voice: valid, speed });
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-voice-"));
  const file = path.join(dir, "speech.wav");
  try {
    await audio.save(file);
    await play(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return true;
}

/** For tests: forget the loaded model. */
export function resetNaturalVoice(): void {
  synth = null;
  loading = null;
  lastError = null;
}
