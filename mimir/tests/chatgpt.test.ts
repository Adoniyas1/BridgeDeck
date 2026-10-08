import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isChatModel, listChatGptModels, streamChatGpt } from "../src/main/chatgpt/client.js";
import { chatToMarkdown, listChats, readChat, titleFrom, writeChat } from "../src/main/chatgpt/store.js";
import type { ChatGptChat, ChatGptStreamEvent } from "../src/shared/types.js";

vi.mock("../src/main/chatgpt/config.js", () => ({
  loadChatGptConfig: async () => ({ model: "gpt-5", hasApiKey: true, instructions: "Be brief." }),
  getChatGptApiKey: async () => "sk-test"
}));

function sse(chunks: string[]): Response {
  const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const delta = (text: string) => JSON.stringify({ choices: [{ delta: { content: text } }] });

describe("ChatGPT client", () => {
  it("streams the reply's text and sends the instructions first", async () => {
    let sent: { model: string; messages: Array<{ role: string; content: string }> } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return sse([delta("Hel"), delta("lo"), "not json"]);
    }) as unknown as typeof fetch;
    const parts: string[] = [];
    for await (const t of streamChatGpt({ apiKey: "k", model: "gpt-5", instructions: "Be brief.", messages: [{ role: "user", content: "Hi" }], fetchImpl })) {
      parts.push(t);
    }
    expect(parts.join("")).toBe("Hello");
    expect(sent!.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" }
    ]);
  });

  it("explains a rejected key", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as unknown as typeof fetch;
    const run = async () => {
      for await (const _ of streamChatGpt({ apiKey: "k", model: "gpt-5", instructions: "", messages: [], fetchImpl })) void _;
    };
    await expect(run()).rejects.toThrow(/didn't accept the API key/);
  });

  it("lists only text chat models", async () => {
    expect(isChatModel("gpt-5")).toBe(true);
    expect(isChatModel("o3-mini")).toBe(true);
    expect(isChatModel("gpt-4o-realtime-preview")).toBe(false);
    expect(isChatModel("text-embedding-3-small")).toBe(false);
    expect(isChatModel("dall-e-3")).toBe(false);
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }, { id: "whisper-1" }, { id: "gpt-5" }, { id: "gpt-5-mini" }] }))) as unknown as typeof fetch;
    expect(await listChatGptModels("k", fetchImpl)).toEqual(["gpt-5-mini", "gpt-5", "gpt-4.1"]);
  });
});

describe("ChatGPT chats", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mimir-chatgpt-"));
  });

  const chat = (id: string, updatedAt: number): ChatGptChat => ({
    id,
    title: id,
    model: "gpt-5",
    messages: [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" }
    ],
    createdAt: 1,
    updatedAt,
    noteId: null
  });

  it("keeps chats on disk, newest first, and refuses odd ids", async () => {
    await writeChat(chat("a", 1), dir);
    await writeChat(chat("b", 2), dir);
    expect((await listChats(dir)).map((c) => c.id)).toEqual(["b", "a"]);
    expect(await readChat("../escape", dir)).toBeNull();
    await expect(writeChat(chat("../escape", 3), dir)).rejects.toThrow(/Bad chat id/);
  });

  it("titles and converts chats for Notes", () => {
    expect(titleFrom("  hello\n world ")).toBe("hello world");
    expect(titleFrom("x".repeat(80))).toHaveLength(58);
    expect(chatToMarkdown(chat("a", 1))).toBe("### You\n\nWhat is 2+2?\n\n### ChatGPT\n\n4");
  });

  it("runs a reply, saves it, and saves the chat to Notes once then updates it", async () => {
    const { ChatGptSession } = await import("../src/main/chatgpt/session.js");
    const events: ChatGptStreamEvent[] = [];
    let finish = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const session = new ChatGptSession({
      dir,
      fetchImpl: (async () => sse([delta("Four.")])) as unknown as typeof fetch,
      broadcast: (_ch, e) => {
        events.push(e);
        if (e.type === "done") finish();
      }
    });
    expect((await session.send("chat-1", "What is 2+2?")).messages[0]).toEqual({ role: "user", content: "What is 2+2?" });
    await finished;
    const saved = await readChat("chat-1", dir);
    expect(saved?.messages.map((m) => m.content)).toEqual(["What is 2+2?", "Four."]);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);

    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const client = {
      call: async <T>(p: string, body?: Record<string, unknown>) => {
        calls.push([p, body]);
        return { id: "note-9" } as T;
      }
    };
    await session.saveToNotes("chat-1", client);
    await session.saveToNotes("chat-1", client);
    expect(calls.map(([p]) => p)).toEqual(["notes/create", "notes/replace"]);
    expect(calls[0][1]).toMatchObject({ title: "What is 2+2?", folder: "ChatGPT" });
    expect(calls[1][1]).toMatchObject({ id: "note-9" });
    await expect(session.saveToNotes("chat-1", null)).rejects.toThrow(/inside BridgeDeck/);
  });
});
