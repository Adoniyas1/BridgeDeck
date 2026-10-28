import { describe, expect, it } from "vitest";
import { engineProblem, fallbackNote } from "../src/main/engines/fallback.js";

describe("an outside agent that can't answer", () => {
  it("says why in plain words, with the fix", () => {
    expect(engineProblem("hermes", "spawn hermes ENOENT").reason).toBe("Hermes isn't installed where Mimir looks");
    expect(engineProblem("hermes", "spawn hermes ENOENT").fix).toMatch(/Install Hermes/);
    expect(engineProblem("hermes", "Hermes: You are not connected to any AI provider yet.").reason).toMatch(/no AI provider/);
    expect(engineProblem("claude-code", "Claude Code: Invalid API key · Please run /login").fix).toMatch(/Run `claude`/);
    expect(engineProblem("opencode", "401 Unauthorized").reason).toBe("OpenCode isn't signed in");
    expect(engineProblem("claude-code", "API Error: 429 rate_limit_error").reason).toMatch(/usage limit/);
    expect(engineProblem("hermes", "Hermes: Internal error\nTraceback ... KeyError: 'model'").reason).toBe("Hermes stopped with an error (Internal error)");
    expect(engineProblem("hermes", "connect ECONNREFUSED 127.0.0.1:8080").reason).toMatch(/couldn't reach its model/);
  });

  it("puts it in one line above Mimir's own answer", () => {
    const note = fallbackNote("hermes", "spawn hermes ENOENT");
    expect(note).toMatch(/^_Hermes couldn't answer: Hermes isn't installed where Mimir looks, so Mimir answered with its own model\. Press Install Hermes/);
    expect(note.endsWith("_\n\n")).toBe(true);
  });
});
