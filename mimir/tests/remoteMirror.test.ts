import { describe, expect, it } from "vitest";
import { ConversationMirror } from "../src/main/remote/mirror.js";

const CH = { faceState: "face", chatStream: "stream" };

describe("the conversation for the phone page", () => {
  it("follows a question, its answer as it streams, and approvals", () => {
    const m = new ConversationMirror();
    m.asked("What's due this week?");
    m.observe("face", ["thinking"], CH);
    m.observe("stream", [{ type: "text-delta", text: "Two things: " }], CH);
    m.observe("stream", [{ type: "approval-pending", approval: { id: "a1", title: "Run a command", detail: "ls", tool: "bash" } }], CH);
    expect(m.get()).toMatchObject({ state: "thinking", busy: true, you: "What's due this week?", reply: "Two things: ", approvals: [{ id: "a1", title: "Run a command" }] });
    m.decided("a1");
    expect(m.get().approvals).toEqual([]);
    const before = m.get().version;
    m.observe("stream", [{ type: "turn-done", fullText: "Two things: EE 310 lab and Math 221 homework." }], CH);
    expect(m.get()).toMatchObject({ busy: false, reply: "Two things: EE 310 lab and Math 221 homework." });
    expect(m.get().version).toBeGreaterThan(before);
    m.observe("other", ["x"], CH);
    m.asked("Thanks");
    expect(m.get().reply).toBe("");
  });

  it("shows an error and stops being busy", () => {
    const m = new ConversationMirror();
    m.asked("hi");
    m.observe("stream", [{ type: "error", message: "The Head model can't be reached" }], CH);
    expect(m.get()).toMatchObject({ busy: false, error: "The Head model can't be reached" });
  });
});
