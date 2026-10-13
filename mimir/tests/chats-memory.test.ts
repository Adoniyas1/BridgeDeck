import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { BrainMessage, BrainProvider, ChatEvent } from "../src/main/brain/Provider.js";
import { runAgentTurn, type AgentStreamEvent } from "../src/main/agent/loop.js";
import { runTeamTurn, type TeamEvent } from "../src/main/team/graph.js";
import { cleanChat, deleteMimirChat, historyFromChat, listMimirChats, readMimirChat, writeMimirChat } from "../src/main/chats/store.js";
import { readMemoryFiles, writeMemoryFiles } from "../src/main/persona/memoryFiles.js";
import { SelfEditTransaction } from "../src/main/self-edit/transaction.js";
import type { ChatMessage } from "../src/shared/types.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir() {
  const d = await mkdtemp(path.join(os.tmpdir(), "mimir-chats-"));
  dirs.push(d);
  return d;
}

const msg = (role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `${role}-${text}`, role, text, createdAt: 1, ...extra });

/** A model that thinks, then answers. */
function thinker(): BrainProvider {
  return {
    kind: "openai-compatible",
    model: "qwen",
    supportsTools: () => true,
    supportsVision: () => false,
    async *chat(): AsyncGenerator<ChatEvent> {
      yield { type: "reasoning-delta", text: "The user said hi. " };
      yield { type: "reasoning-delta", text: "A short greeting back." };
      yield { type: "text-delta", text: "Hi there!" };
      yield { type: "done", stopReason: "end_turn" };
    }
  } as unknown as BrainProvider;
}

describe("saved chats", () => {
  it("saves, lists, reopens and deletes a chat, and skips one with only the greeting", async () => {
    const dir = await tempDir();
    expect(await writeMimirChat({ id: "a1", title: "", messages: [msg("assistant", "I'm Mimir.")], createdAt: 1, updatedAt: 1 }, dir)).toBeNull();
    expect(await listMimirChats(dir)).toEqual([]);

    const messages = [
      msg("assistant", "I'm Mimir."),
      msg("user", "explain calc 1-3"),
      msg("assistant", "Calculus 1 is…", { thinking: "They want an overview.", thinkingMs: 2100 }),
      msg("system", "⚠️ something failed")
    ];
    const saved = await writeMimirChat({ id: "a1", title: "", messages, createdAt: 1, updatedAt: 5 }, dir);
    expect(saved!.title).toBe("explain calc 1-3");
    await writeMimirChat({ id: "b2", title: "Later chat", messages: [msg("user", "hi")], createdAt: 2, updatedAt: 9 }, dir);
    expect((await listMimirChats(dir)).map((c) => c.id)).toEqual(["b2", "a1"]);

    const back = (await readMimirChat("a1", dir))!;
    expect(back.messages[2]).toMatchObject({ thinking: "They want an overview.", thinkingMs: 2100 });
    // What the model continues from: no greeting before the first question, no error notes, no thinking.
    expect(historyFromChat(back)).toEqual([
      { role: "user", content: "explain calc 1-3" },
      { role: "assistant", content: "Calculus 1 is…" }
    ]);

    await deleteMimirChat("a1", dir);
    expect((await listMimirChats(dir)).map((c) => c.id)).toEqual(["b2"]);
  });

  it("refuses bad ids and junk from the renderer", async () => {
    expect(cleanChat({ id: "../../etc", messages: [] })).toBeNull();
    expect(cleanChat({ id: "ok", messages: "nope" })).toBeNull();
    const c = cleanChat({ id: "ok", messages: [{ role: "hacker", text: "x" }, { role: "user", text: 3 }, { role: "user", text: "fine", extra: 1 }] })!;
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]).not.toHaveProperty("extra");
    await expect(writeMimirChat({ id: "../x", messages: [msg("user", "hi")] }, await tempDir())).resolves.toBeNull();
  });
});

describe("thinking", () => {
  it("comes out of the agent loop separately from the reply, and isn't part of the history", async () => {
    const events: AgentStreamEvent[] = [];
    const turn = runAgentTurn([{ role: "user", content: "hi" }], { provider: thinker(), system: "", tools: [], handlers: {} });
    let r = await turn.next();
    while (!r.done) {
      events.push(r.value);
      r = await turn.next();
    }
    expect(events.filter((e) => e.type === "thinking").map((e) => (e as { text: string }).text).join("")).toBe("The user said hi. A short greeting back.");
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Hi there!");
    const history = r.value as BrainMessage[];
    expect(JSON.stringify(history)).not.toContain("greeting back");
  });

  it("shows the Head's thinking in a team reply", async () => {
    const events: TeamEvent[] = [];
    const out = await runTeamTurn({
      head: { provider: thinker(), model: "qwen" },
      executor: { provider: thinker(), model: "bonsai" },
      checker: { provider: thinker(), model: "qwen" },
      history: [],
      message: { role: "user", content: "hi" },
      kitFor: async () => ({ system: "core", tools: [], handlers: {} }),
      catalog: [],
      needsTools: false,
      checkEachStep: true,
      emit: (e) => events.push(e),
      cancelled: () => false
    });
    expect(out.reply).toBe("Hi there!");
    expect(events.some((e) => e.type === "thinking" && e.text.includes("said hi"))).toBe(true);
  });
});

describe("memory panel", () => {
  it("reads and saves MEMORY.md and USER.md through the audited transaction", async () => {
    const ws = await tempDir();
    await mkdir(path.join(ws, "persona"), { recursive: true });
    await writeFile(path.join(ws, "persona", "MEMORY.md"), "- Likes calculus\n");
    const git = simpleGit(ws);
    await git.init();
    await git.addConfig("user.name", "Test");
    await git.addConfig("user.email", "test@localhost");
    await git.add(["-A"]);
    await git.commit("initial");
    const audit = path.join(await tempDir(), "audit.json");

    expect(await readMemoryFiles(ws)).toMatchObject({ memory: "- Likes calculus\n", user: "" });
    const next = await writeMemoryFiles(ws, new SelfEditTransaction(ws, audit), { user: "Name: Adoniyas\n" });
    expect(next).toMatchObject({ memory: "- Likes calculus\n", user: "Name: Adoniyas\n" });
    expect(await readFile(path.join(ws, "persona", "USER.md"), "utf-8")).toBe("Name: Adoniyas\n");
    expect(await readFile(audit, "utf-8")).toContain("Memory edited in the Memory panel");
    await expect(writeMemoryFiles(ws, new SelfEditTransaction(ws, audit), { memory: "x".repeat(200_000) })).rejects.toThrow(/limit/);
  });
});
