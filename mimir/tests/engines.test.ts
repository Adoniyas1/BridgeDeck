import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { estimateTokens, startAnthropicBridge, StreamTranslator, toOpenAIRequest, type AnthropicBridge } from "../src/main/engines/anthropicBridge.js";
import { ClaudeStreamParser, runClaudeCode } from "../src/main/engines/claudeCode.js";
import { describeToolCall, roleForModel, type EngineEvent, type EngineTurn } from "../src/main/engines/common.js";
import { OpenCodeAgent, openCodeConfig } from "../src/main/engines/openCode.js";
import { HermesAgent, hermesConfig, honchoConfig } from "../src/main/engines/hermes.js";
import { cleanTeamConfig, DEFAULT_TEAM } from "../src/main/team/config.js";
import type { ToolApproval } from "../src/shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fixtures", "fake-claude.mjs");
const fakeAcp = path.join(here, "fixtures", "fake-acp-agent.mjs");
const approvalServer = path.join(here, "..", "src", "main", "engines", "approvalServer.ts");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-engine-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function turnIn(cwd: string, prompt: string, allow: boolean, projectsRoot = path.join(cwd, "elsewhere")) {
  const events: EngineEvent[] = [];
  const asked: Array<Omit<ToolApproval, "id">> = [];
  const turn: EngineTurn = {
    prompt,
    cwd,
    projectsRoot,
    approve: async (req) => {
      asked.push(req);
      return allow;
    },
    emit: (e) => events.push(e),
    signal: new AbortController().signal
  };
  return { turn, events, asked };
}

/** A stand-in OpenAI-compatible server: a tool call when tools are offered, else a reply. */
async function fakeOpenAI(): Promise<{ url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; tools?: unknown[]; messages: Array<{ role: string }> };
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (body.tools?.length && !body.messages.some((m) => m.role === "tool")) {
        send({ choices: [{ delta: { content: "Checking." } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "Bash", arguments: '{"comm' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ choices: [{ delta: { content: `Hi from ${body.model}` } }] });
        send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

describe("Anthropic-to-OpenAI bridge", () => {
  it("translates a Messages request: system, tool calls, tool results first, images, tools", () => {
    const out = toOpenAIRequest(
      {
        model: "mimir-head",
        max_tokens: 1000,
        system: [{ type: "text", text: "Be brief." }],
        tool_choice: { type: "any" },
        tools: [{ name: "Bash", description: "Run", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }],
        messages: [
          { role: "user", content: "list files" },
          { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Sure." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
          {
            role: "user",
            content: [
              { type: "text", text: "and this picture" },
              { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }] },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }
            ]
          }
        ]
      },
      "qwen3.5-9b"
    );
    expect(out).toMatchObject({ model: "qwen3.5-9b", max_tokens: 1000, stream: true, tool_choice: "required" });
    expect(out.tools).toEqual([{ type: "function", function: { name: "Bash", description: "Run", parameters: { type: "object" } } }]);
    expect(out.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "list files" },
      { role: "assistant", content: "Sure.", tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "a.txt" },
      { role: "user", content: [{ type: "text", text: "and this picture" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }
    ]);
  });

  it("turns an OpenAI stream into Anthropic events, ending a tool call with tool_use", () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const t = new StreamTranslator("m", (e, d) => events.push([e, d]), "msg_1");
    t.chunk({ choices: [{ delta: { content: "Hi" } }] });
    t.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: '{"a":' } }] } }] });
    t.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "stop" }] });
    t.finish();
    expect(events.map(([e]) => e)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
    expect(events[4]![1]).toMatchObject({ index: 1, content_block: { type: "tool_use", id: "c1", name: "Read" } });
    expect(events[8]![1]).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  it("serves streaming and whole messages, routes by model name and checks the key", async () => {
    const upstream = await fakeOpenAI();
    const routed: string[] = [];
    const bridge: AnthropicBridge = await startAnthropicBridge(async (model) => {
      routed.push(model);
      return { baseUrl: upstream.url, model: roleForModel(model) === "executor" ? "small-m" : "big-m" };
    });
    cleanups.push(() => bridge.close());
    const post = (pathname: string, body: unknown, key = bridge.secret) =>
      fetch(`${bridge.url}${pathname}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });

    expect((await post("/v1/messages", { model: "x", messages: [] }, "wrong")).status).toBe(401);

    const whole = (await (await post("/v1/messages", { model: "mimir-executor", max_tokens: 50, messages: [{ role: "user", content: "hi" }] })).json()) as Record<string, unknown>;
    expect(whole).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Hi from small-m" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 4 } });

    const streamed = await (
      await post("/v1/messages?beta=true", { model: "mimir-head", stream: true, max_tokens: 50, tools: [{ name: "Bash", input_schema: { type: "object" } }], messages: [{ role: "user", content: "ls" }] })
    ).text();
    expect(streamed).toContain("event: message_start");
    expect(streamed).toContain('"partial_json":"{\\"comm"');
    expect(streamed).toContain('"stop_reason":"tool_use"');
    expect(routed).toEqual(["mimir-executor", "mimir-head"]);
    expect(upstream.bodies.map((b) => b.model)).toEqual(["small-m", "big-m"]);

    const count = (await (await post("/v1/messages/count_tokens", { messages: [{ role: "user", content: "hello there" }] })).json()) as { input_tokens: number };
    expect(count.input_tokens).toBe(estimateTokens({ messages: [{ role: "user", content: "hello there" }] }));
  });

  it("says which server is off instead of failing quietly", async () => {
    const bridge = await startAnthropicBridge(async () => {
      throw new Error("The Head model can't be reached: http://pc:8080 isn't answering.");
    });
    cleanups.push(() => bridge.close());
    const res = await fetch(`${bridge.url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${bridge.secret}` }, body: JSON.stringify({ model: "m", messages: [] }) });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("isn't answering");
  });
});

describe("Claude Code engine", () => {
  it("reads stream-json: deltas once, whole messages when nothing streamed, tools and the session", () => {
    const events: EngineEvent[] = [];
    const p = new ClaudeStreamParser((e) => events.push(e));
    const lines = [
      { type: "system", subtype: "init", session_id: "s9" },
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Look" } } },
      { type: "assistant", message: { content: [{ type: "text", text: "Look" }, { type: "tool_use", id: "a", name: "Read", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: true }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
      { type: "result", is_error: false, result: "Done." }
    ];
    for (const l of lines) p.line(JSON.stringify(l));
    p.line("not json");
    expect(p.sessionId).toBe("s9");
    expect(p.reply).toBe("Look\n\nDone.");
    expect(events.filter((e) => e.type !== "text")).toEqual([
      { type: "tool-start", id: "a", name: "Read" },
      { type: "tool-end", id: "a", name: "Read", isError: true }
    ]);
    expect(p.result).toEqual({ text: "Done.", isError: false });
  });

  it("runs claude headless on the team's models, asks through the approval tool, and resumes", async () => {
    const cwd = await tempDir();
    const record = path.join(cwd, "record.json");
    process.env.FAKE_CLAUDE_RECORD = record;
    cleanups.push(() => void delete process.env.FAKE_CLAUDE_RECORD);

    const { turn, events, asked } = turnIn(cwd, "make a file", true);
    const result = await runClaudeCode(turn, { command: fakeClaude, team: DEFAULT_TEAM, resume: null, approvalServer, route: async () => ({ baseUrl: "http://unused", model: "m" }) });
    expect(result).toEqual({ text: "Making it.\n\nMade it.", sessionId: "sess-1" });
    expect(asked).toEqual([{ tool: "Bash", title: "Run a command", detail: "Make a file\n\ntouch made.txt" }]);
    expect(existsSync(path.join(cwd, "made.txt"))).toBe(true);
    expect(events.filter((e) => e.type !== "text").map((e) => e.type)).toEqual(["tool-start", "tool-end"]);

    const seen = JSON.parse(await readFile(record, "utf8")) as { args: string[]; prompt: string; env: Record<string, string | null> };
    expect(seen.prompt).toBe("make a file");
    expect(seen.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--model", "mimir-head", "--permission-prompt-tool", "mcp__mimir__approve"]));
    // Outside Projects, so it asks for everything ("manual" or "default", by version).
    expect(seen.args[seen.args.indexOf("--permission-mode") + 1]).toMatch(/^(manual|default)$/);
    expect(seen.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(seen.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("mimir-executor");

    const again = turnIn(cwd, "once more", false, cwd);
    const second = await runClaudeCode(again.turn, { command: fakeClaude, team: null, resume: "sess-1", approvalServer });
    expect(second.text).toBe("Making it.\n\nYou didn't allow it.");
    const seen2 = JSON.parse(await readFile(record, "utf8")) as { args: string[]; env: Record<string, string | null> };
    expect(seen2.args).toEqual(expect.arrayContaining(["--resume", "sess-1", "--permission-mode", "acceptEdits"]));
    expect(seen2.args).not.toContain("--model");
    expect(seen2.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeNull();
  }, 60_000);

  it("reports Claude Code's own error and a missing command", async () => {
    const cwd = await tempDir();
    const failing = turnIn(cwd, "please fail", true);
    await expect(runClaudeCode(failing.turn, { command: fakeClaude, team: null, resume: null, approvalServer })).rejects.toThrow("Claude Code stopped: the model server is off");
    const missing = turnIn(cwd, "hi", true);
    await expect(runClaudeCode(missing.turn, { command: "no-such-claude-cmd", team: null, resume: null, approvalServer })).rejects.toThrow(/Claude Code isn't installed/);
  }, 30_000);
});

describe("OpenCode engine", () => {
  it("talks ACP: asks before commands, streams the reply, and keeps the session between messages", async () => {
    const cwd = await tempDir();
    const record = path.join(cwd, "config.json");
    process.env.FAKE_ACP_RECORD = record;
    cleanups.push(() => void delete process.env.FAKE_ACP_RECORD);
    const agent = new OpenCodeAgent();
    cleanups.push(() => agent.stop());
    const models = { head: { baseUrl: "http://pc:8080", model: "qwen3.5-35b-a3b" }, executor: { baseUrl: "http://127.0.0.1:8080", model: "bonsai-8b" } };

    const first = turnIn(cwd, "run echo", true);
    expect(await agent.run(first.turn, { command: fakeAcp, models })).toEqual({ text: "Turn 1 in ses_1: ran it (run echo)." });
    expect(first.asked).toEqual([{ tool: "bash", title: "Run a command", detail: "echo hi" }]);
    expect(first.events.filter((e) => e.type !== "text")).toEqual([
      { type: "tool-start", id: "c1", name: "bash" },
      { type: "tool-end", id: "c1", name: "bash", isError: false }
    ]);
    const config = JSON.parse(await readFile(record, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({ model: "mimir-head/qwen3.5-35b-a3b", small_model: "mimir-executor/bonsai-8b", permission: { bash: "ask", edit: "ask" } });

    const second = turnIn(cwd, "again", false);
    expect((await agent.run(second.turn, { command: fakeAcp, models })).text).toBe("Turn 2 in ses_1: not allowed (again).");

    // New models: a fresh OpenCode (and session).
    const third = turnIn(cwd, "new models", true);
    expect((await agent.run(third.turn, { command: fakeAcp, models: null })).text).toBe("Turn 1 in ses_1: ran it (new models).");
    expect(JSON.parse(await readFile(record, "utf8"))).not.toHaveProperty("provider");
  }, 30_000);

  it("lets file changes in Projects through and says when OpenCode isn't installed", async () => {
    expect(openCodeConfig(null, true)).toMatchObject({ permission: { bash: "ask", edit: "allow" } });
    const cwd = await tempDir();
    const agent = new OpenCodeAgent();
    cleanups.push(() => agent.stop());
    await expect(agent.run(turnIn(cwd, "hi", true).turn, { command: "no-such-opencode-cmd", models: null })).rejects.toThrow(/OpenCode isn't installed/);
  });
});

describe("Hermes engine", () => {
  it("runs in Mimir's own profile with the team's model, and starts each conversation with what Mimir knows", async () => {
    const cwd = await tempDir();
    const home = path.join(cwd, "hermes-home");
    const agent = new HermesAgent();
    cleanups.push(() => agent.stop());
    const model = { baseUrl: "http://pc:8080/", model: "bonsai-2-27b" };
    const first = turnIn(cwd, "run echo", true);
    const one = await agent.run(first.turn, { command: fakeAcp, model, honcho: null, intro: "About the user: EE student", home });
    expect(one.text).toBe("Turn 1 in ses_1: ran it (About the user: EE student\n\n---\n\nrun echo).");
    const config = await readFile(path.join(home, "config.yaml"), "utf8");
    expect(config).toContain('provider: custom');
    expect(config).toContain('default: "bonsai-2-27b"');
    expect(config).toContain('base_url: "http://pc:8080/v1"');
    expect(config).not.toContain("honcho");
    // The same conversation: no intro again.
    const two = await agent.run(turnIn(cwd, "again", true).turn, { command: fakeAcp, model, honcho: null, intro: "About the user: EE student", home });
    expect(two.text).toBe("Turn 2 in ses_1: ran it (again).");
  }, 30_000);

  it("writes Honcho's settings when chosen and says when Hermes isn't installed", async () => {
    const honcho = { apiKey: "hk_1", baseUrl: null, peerName: "adoniyas" };
    expect(hermesConfig({ baseUrl: "http://127.0.0.1:8080", model: "m" }, honcho)).toContain("memory:\n  provider: honcho");
    expect(JSON.parse(honchoConfig(honcho))).toMatchObject({ apiKey: "hk_1", peerName: "adoniyas", aiPeer: "mimir" });
    expect(JSON.parse(honchoConfig({ apiKey: null, baseUrl: "http://localhost:8000", peerName: "me" }))).not.toHaveProperty("apiKey");
    const cwd = await tempDir();
    const agent = new HermesAgent();
    cleanups.push(() => agent.stop());
    await expect(agent.run(turnIn(cwd, "hi", true).turn, { command: "no-such-hermes-cmd", model: null, honcho: null })).rejects.toThrow(/Hermes isn't installed/);
  });
});

describe("engine settings", () => {
  it("cleans the engine fields and describes tool calls for the approval card", () => {
    const c = cleanTeamConfig({ engine: "opencode", engineModels: "own", engineCommands: { "claude-code": "  /opt/claude  ", opencode: "" } });
    expect(c).toMatchObject({ engine: "opencode", engineModels: "own", engineCommands: { "claude-code": "/opt/claude", opencode: null, hermes: null } });
    expect(cleanTeamConfig({ engine: "nope", engineModels: "x" })).toMatchObject({ engine: "mimir", engineModels: "team", engineCommands: { "claude-code": null, opencode: null, hermes: null } });
    expect(cleanTeamConfig({ engine: "hermes", honcho: { enabled: true, baseUrl: "ftp://x", peerName: "bad name!" } })).toMatchObject({ engine: "hermes", honcho: { enabled: true, baseUrl: null, peerName: "me" } });
    expect(describeToolCall("Edit", { file_path: "/x/a.ts", old_string: "a", new_string: "b" })).toEqual({ title: "Change /x/a.ts", detail: "- a\n+ b" });
    expect(describeToolCall("write", { filePath: "b.md", content: "hi" })).toEqual({ title: "Write b.md", detail: "hi" });
    expect(describeToolCall("mcp__git__commit", { message: "m" }).title).toBe("Use mcp__git__commit");
    expect(roleForModel("claude-haiku-4-5")).toBe("executor");
    expect(roleForModel("mimir-head")).toBe("head");
  });
});
