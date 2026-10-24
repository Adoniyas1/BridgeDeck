import { describe, expect, it, vi } from "vitest";
import type { BrainProvider } from "../src/main/brain/Provider.js";

vi.mock("../src/main/team/config.js", async (orig) => ({ ...(await orig<object>()), loadTeamConfig: vi.fn() }));
const { loadTeamConfig } = await import("../src/main/team/config.js");
const { visionReading, withReading } = await import("../src/main/team/vision.js");

const fake = (reply: string): BrainProvider => ({
  kind: "openai-compatible", model: "vision", supportsTools: () => false, supportsVision: () => true,
  async *chat(messages) {
    expect(messages[0].role).toBe("user");
    expect((messages[0] as { attachments?: unknown[] }).attachments).toHaveLength(1);
    yield { type: "text-delta", text: reply };
    yield { type: "done", stopReason: "end_turn" };
  }
});

describe("vision model", () => {
  it("reads pictures when one is set", async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({ vision: { provider: "openai-compatible", model: "qwen3.5-9b", baseUrl: "http://x" } } as never);
    const reading = await visionReading([{ mimeType: "image/png", data: "AAAA" }], async () => fake("$V = IR$"));
    expect(reading).toBe("$V = IR$");
    expect(withReading("The photo.", reading)).toContain("reading of the picture:\n$V = IR$");
  });
  it("does nothing when none is set or it fails", async () => {
    vi.mocked(loadTeamConfig).mockResolvedValue({ vision: null } as never);
    expect(await visionReading([{ mimeType: "image/png", data: "AAAA" }], async () => fake("x"))).toBeNull();
    vi.mocked(loadTeamConfig).mockResolvedValue({ vision: { provider: "openai-compatible", model: "m", baseUrl: null } } as never);
    expect(await visionReading([{ mimeType: "image/png", data: "AAAA" }], async () => { throw new Error("down"); })).toBeNull();
    expect(withReading("text", null)).toBe("text");
  });
});
