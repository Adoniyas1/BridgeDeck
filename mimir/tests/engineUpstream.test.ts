import { describe, expect, it, vi } from "vitest";

vi.mock("../src/main/brain/config.js", async (orig) => ({
  ...(await orig<typeof import("../src/main/brain/config.js")>()),
  loadBrainConfig: vi.fn(async () => ({ provider: "ollama", model: "llama3.2:3b", baseUrl: null, hasApiKey: false, autoApproveCoreEdits: false, effort: "medium", webSearchEnabled: false })),
  getBrainApiKey: vi.fn(async () => null)
}));

const { roleUpstream } = await import("../src/main/engines/common.js");
const { DEFAULT_TEAM } = await import("../src/main/team/config.js");

describe("the model an agent gets", () => {
  it("is the Brain's one model (here Ollama) when Mimir is set to one model", async () => {
    const team = { ...structuredClone(DEFAULT_TEAM), mode: "single" as const };
    expect(await roleUpstream(team, "head")).toMatchObject({ baseUrl: "http://localhost:11434", model: "llama3.2:3b", ollama: true });
  });
});
