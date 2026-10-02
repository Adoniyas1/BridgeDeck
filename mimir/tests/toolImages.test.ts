import { describe, expect, it } from "vitest";
import type { BrainMessage, BrainProvider, ChatEvent } from "../src/main/brain/Provider.js";
import { runAgentTurn, TOOL_IMAGES_NOTE } from "../src/main/agent/loop.js";
import { buildBridgeDeckToolset } from "../src/main/bridgedeck/tools.js";

/** A provider that asks to look twice, then answers; it records what it was sent each time. */
function scriptedProvider() {
  const seen: BrainMessage[][] = [];
  let turn = 0;
  const provider = {
    kind: "anthropic", model: "test",
    supportsTools: () => true, supportsVision: () => true,
    async *chat(messages: BrainMessage[]): AsyncGenerator<ChatEvent> {
      seen.push(structuredClone(messages));
      turn++;
      if (turn <= 2) {
        yield { type: "tool-call", call: { id: `c${turn}`, name: "computer_look", input: { computer: "PC" } } };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text-delta", text: "I can see your editor." };
        yield { type: "done", stopReason: "end_turn" };
      }
    }
  } as unknown as BrainProvider;
  return { provider, seen };
}

describe("screens Mimir looks at", () => {
  it("reach the model as an image, and only the newest stays attached", async () => {
    let shots = 0;
    const tools = buildBridgeDeckToolset({ async call<T>(path: string, body: Record<string, unknown> = {}) {
      expect(path).toBe("computers/look");
      expect(body).toEqual({ computer: "PC", monitor: 0 });
      shots++;
      return { width: 1366, height: 768, jpeg: `JPEG${shots}` } as T;
    } });
    const { provider, seen } = scriptedProvider();
    const turn = runAgentTurn([{ role: "user", content: "What's on my PC?" }], { provider, system: "", tools: tools.defs, handlers: tools.handlers });
    let result = await turn.next();
    while (!result.done) result = await turn.next();

    const second = seen[1]!;
    const attached = second.at(-1)!;
    expect(second.at(-2)).toMatchObject({ role: "tool", content: "Screenshot of PC: 1366×768 pixels (attached for you to look at).", toolCallId: "c1" });
    expect(attached).toMatchObject({ role: "user", content: TOOL_IMAGES_NOTE, attachments: [{ kind: "image", mimeType: "image/jpeg", data: "JPEG1" }] });

    const third = seen[2]!;
    const images = third.filter((m) => m.role === "user" && m.attachments?.length);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ attachments: [{ data: "JPEG2" }] });
    expect(third.some((m) => m.role === "user" && m.content.includes("older image, no longer attached"))).toBe(true);
  });

  it("is look only: the toolbox has no way to click or type on another computer", () => {
    const tools = buildBridgeDeckToolset({ call: async () => ({}) as never });
    expect(tools.defs.map((d) => d.name).filter((n) => /click|type|key|control|input/i.test(n))).toEqual([]);
  });
});
