import { describe, expect, it } from "vitest";
import { tryEngine } from "../src/main/engines/index.js";
import { DEFAULT_TEAM } from "../src/main/team/config.js";

const team = { ...structuredClone(DEFAULT_TEAM), engine: "claude-code" as const };

describe("trying the chosen agent", () => {
  it("sends one short message it can't act on, and times the answer", async () => {
    let prompt = "";
    let approved: boolean | null = null;
    const r = await tryEngine(team, 5000, {
      run: async (_t, turn) => { prompt = turn.prompt; approved = await turn.approve({ id: "x", title: "Write a file", detail: "" } as never); return { text: "ready" }; },
      close: () => undefined
    });
    expect(r).toMatchObject({ ok: true, message: "ready", borrowed: false });
    expect(prompt).toMatch(/connection check/);
    expect(approved).toBe(false);
  });

  it("reports the error, or a time-out", async () => {
    const failed = await tryEngine(team, 5000, { run: async () => { throw new Error("spawn claude ENOENT"); }, close: () => undefined });
    expect(failed).toMatchObject({ ok: false, message: "spawn claude ENOENT" });
    const slow = await tryEngine(team, 50, { run: (_t, turn) => new Promise((_, reject) => turn.signal.addEventListener("abort", () => reject(new Error("aborted")))), close: () => undefined });
    expect(slow.ok).toBe(false);
    expect(slow.message).toMatch(/timed out/);
  });
});
