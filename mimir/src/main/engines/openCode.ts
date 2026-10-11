import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isInside } from "../coding/tools.js";
import { describeToolCall, spawnCommand, startError, type EngineResult, type EngineTurn } from "./common.js";
import type { Upstream } from "./anthropicBridge.js";

/**
 * OpenCode as Mimir's agent, over ACP (the Agent Client Protocol: JSON-RPC on stdio, `opencode
 * acp`). One OpenCode process stays up between messages so the conversation carries on; it's
 * restarted when the models or folder change. OpenCode asks before every command (and every file
 * change outside Projects) with session/request_permission, which shows as an Allow / Deny card.
 */

type Json = Record<string, unknown>;

export interface OpenCodeModels {
  head: Upstream;
  executor: Upstream;
}

/** OpenCode's config for this run: the team's two models as OpenAI-compatible providers (or none,
 * to keep OpenCode's own), and the permission rules. */
export function openCodeConfig(models: OpenCodeModels | null, editsAllowed: boolean): Json {
  const config: Json = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    permission: { bash: "ask", edit: editsAllowed ? "allow" : "ask", webfetch: "allow", external_directory: "ask" }
  };
  if (models) {
    const provider = (name: string, u: Upstream) => ({
      npm: "@ai-sdk/openai-compatible",
      name,
      options: { baseURL: `${u.baseUrl}/v1`, ...(u.apiKey ? { apiKey: u.apiKey } : {}) },
      models: { [u.model]: { name: u.model, tool_call: true } }
    });
    config.provider = { "mimir-head": provider("Mimir Head", models.head), "mimir-executor": provider("Mimir Executor", models.executor) };
    config.model = `mimir-head/${models.head.model}`;
    config.small_model = `mimir-executor/${models.executor.model}`;
  }
  return config;
}

/** Maps ACP session updates to Mimir events. */
export function handleUpdate(update: Json, turn: Pick<EngineTurn, "emit">, state: { text: string; tools: Map<string, string> }): void {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const content = update.content as Json | undefined;
    if (content?.type === "text" && typeof content.text === "string" && content.text) {
      state.text += content.text;
      turn.emit({ type: "text", text: content.text });
    }
  } else if (kind === "tool_call") {
    const id = String(update.toolCallId);
    const name = String(update.title ?? update.kind ?? "tool");
    if (!state.tools.has(id)) {
      state.tools.set(id, name);
      turn.emit({ type: "tool-start", id, name });
    }
  } else if (kind === "tool_call_update") {
    const id = String(update.toolCallId);
    const name = state.tools.get(id);
    if (name && (update.status === "completed" || update.status === "failed")) {
      turn.emit({ type: "tool-end", id, name, isError: update.status === "failed" });
      state.tools.delete(id);
    }
  }
}

const TOOL_BY_KIND: Record<string, string> = { execute: "bash", edit: "edit", fetch: "webfetch", delete: "edit", move: "edit" };

export class OpenCodeAgent {
  private child: ChildProcessWithoutNullStreams | null = null;
  private key = "";
  private sessionId: string | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private turn: { turn: EngineTurn; state: { text: string; tools: Map<string, string> } } | null = null;
  private stderr: string[] = [];

  private send(message: Json): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  private call(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  private onMessage(msg: Json): void {
    if (typeof msg.id === "number" && !msg.method) {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(String((msg.error as Json).message ?? "OpenCode error")));
      else w.resolve((msg.result ?? {}) as Json);
      return;
    }
    const params = (msg.params ?? {}) as Json;
    if (msg.method === "session/update" && this.turn) {
      handleUpdate((params.update ?? {}) as Json, this.turn.turn, this.turn.state);
    } else if (msg.method === "session/request_permission") {
      void this.permission(msg.id, params);
    } else if (msg.id !== undefined && msg.method) {
      // A request we don't serve (file system, terminal): we told OpenCode we can't.
      this.send({ id: msg.id, error: { code: -32601, message: "Not supported" } });
    }
  }

  private async permission(id: unknown, params: Json): Promise<void> {
    const options = (params.options ?? []) as Array<{ optionId: string; kind: string }>;
    const call = (params.toolCall ?? {}) as Json;
    const input = (call.rawInput ?? {}) as Record<string, unknown>;
    const tool = TOOL_BY_KIND[String(call.kind)] ?? String(call.title ?? "tool");
    const allowed = this.turn ? await this.turn.turn.approve({ tool, ...describeToolCall(tool, input) }) : false;
    const pick = options.find((o) => o.kind === (allowed ? "allow_once" : "reject_once")) ?? options.find((o) => o.kind.startsWith(allowed ? "allow" : "reject"));
    this.send({ id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
  }

  private async start(command: string, cwd: string, config: Json): Promise<void> {
    this.stop();
    this.stderr = [];
    const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: "1" };
    const child = spawnCommand(command, ["acp"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.child = child;
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let at: number;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at).trim();
        buf = buf.slice(at + 1);
        if (!line) continue;
        try {
          this.onMessage(JSON.parse(line) as Json);
        } catch {
          /* not a protocol line */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      this.stderr.push(d.toString());
      if (this.stderr.length > 50) this.stderr.shift();
    });
    const failAll = (err: Error) => this.failWaiting(err);
    // Only the current process's end matters; one we replaced was stopped on purpose.
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.forget();
      failAll(startError("opencode", command, err));
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.forget();
      failAll(new Error(`OpenCode exited (${code}): ${this.stderr.join("").trim().slice(-800) || "no output"}`));
    });
    await this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  }

  /** One message. Starts (or restarts) OpenCode when the command, folder or models changed. */
  async run(turn: EngineTurn, options: { command: string; models: OpenCodeModels | null }): Promise<EngineResult> {
    const config = openCodeConfig(options.models, isInside(turn.projectsRoot, turn.cwd));
    const key = JSON.stringify([options.command, turn.cwd, config]);
    if (!this.child || key !== this.key) {
      await this.start(options.command, turn.cwd, config);
      this.key = key;
    }
    if (!this.sessionId) {
      const created = await this.call("session/new", { cwd: turn.cwd, mcpServers: [] });
      this.sessionId = String(created.sessionId);
    }
    const sessionId = this.sessionId;
    const state = { text: "", tools: new Map<string, string>() };
    this.turn = { turn, state };
    const cancel = () => this.send({ method: "session/cancel", params: { sessionId } });
    turn.signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.call("session/prompt", { sessionId, prompt: [{ type: "text", text: turn.prompt }] });
      if (result.stopReason === "refusal") throw new Error("OpenCode's model refused this request.");
      return { text: state.text };
    } finally {
      turn.signal.removeEventListener("abort", cancel);
      this.turn = null;
    }
  }

  private failWaiting(err: Error): void {
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
  }

  private forget(): void {
    this.child = null;
    this.sessionId = null;
    this.key = "";
  }

  stop(): void {
    const child = this.child;
    this.forget();
    this.failWaiting(new Error("OpenCode was stopped."));
    child?.kill();
  }
}
