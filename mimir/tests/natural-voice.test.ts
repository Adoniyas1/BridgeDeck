import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { loadNaturalVoice, naturalVoiceStatus, resetNaturalVoice, speakNatural } from "../src/main/voice/natural.js";

afterEach(() => resetNaturalVoice());

/** A stand-in for Kokoro: "speaks" by writing the text into the file. */
function fakeSynth(calls: Array<{ text: string; voice: string }>) {
  return async () => ({
    async generate(text: string, opts: { voice: string; speed: number }) {
      calls.push({ text, voice: opts.voice });
      return { save: (file: string) => writeFile(file, `RIFF ${text}`) };
    }
  });
}

describe("natural voice", () => {
  it("says it isn't ready (so the system voice speaks) until the model is loaded", async () => {
    let started = false;
    // Not loaded: speakNatural starts loading and reports false straight away.
    void loadNaturalVoice(() => {
      started = true;
      return new Promise(() => undefined);
    });
    expect(started).toBe(true);
    expect(naturalVoiceStatus().state).toBe("loading");
    expect(await speakNatural("Hello.", "af_heart", async () => undefined)).toBe(false);
  });

  it("speaks into a WAV file, plays it, then cleans it up", async () => {
    const calls: Array<{ text: string; voice: string }> = [];
    await loadNaturalVoice(fakeSynth(calls));
    expect(naturalVoiceStatus()).toEqual({ state: "ready", error: null });
    let played = "";
    let content = "";
    const ok = await speakNatural("Hi, I'm Mimir.", "bm_george", async (file) => {
      played = file;
      content = await readFile(file, "utf-8");
    });
    expect(ok).toBe(true);
    expect(played).toMatch(/speech\.wav$/);
    expect(content).toBe("RIFF Hi, I'm Mimir.");
    expect(existsSync(played)).toBe(false);
    // An unknown voice falls back to the default one.
    await speakNatural("Again.", "nobody", async () => undefined);
    expect(calls.map((c) => c.voice)).toEqual(["bm_george", "af_heart"]);
  });

  it("reports a failed download, and can try again later", async () => {
    await expect(loadNaturalVoice(async () => Promise.reject(new Error("fetch failed")))).rejects.toThrow("fetch failed");
    expect(naturalVoiceStatus()).toEqual({ state: "failed", error: "fetch failed" });
    await loadNaturalVoice(fakeSynth([]));
    expect(naturalVoiceStatus().state).toBe("ready");
  });
});
