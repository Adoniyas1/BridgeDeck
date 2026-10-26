import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describeToolCall, spawnCommand, startError, type EngineName, type EngineResult, type EngineTurn } from "./common.js";

/**
 * An agent spoken to over ACP (the Agent Client Protocol: JSON-RPC on stdio), as OpenCode
 * (`opencode acp`) and Hermes (`hermes acp`) both do. One process stays up between messages so the
 * conversation carries on; it's restarted when its command, folder or setup change. The agent asks
 * before every command (and file change outside Projects) with session/request_permission, which
 * shows as an Allow / Deny card.
 */

type Json = Record<string, unknown>;

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

/** How to start the agent, and what its sessions get. */
export interface AcpLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Extra text for the first message of a session (context the agent should know). */
  intro?: string;
  /** MCP servers given to each new session (ACP `mcpServers`). */
  mcpServers?: Json[];
}

const TOOL_BY_KIND: Record<string, string> = { execute: "bash", edit: "edit", fetch: "webfetch", delete: "edit", move: "edit" };

export class AcpAgent {
  constructor(private engine: EngineName) {}

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
      if (msg.error) w.reject(new Error(errorText(this.label, msg.error as Json, this.stderr)));
      else w.resolve((msg.result ?? {}) as Json);
      return;
    }
    const params = (msg.params ?? {}) as Json;
    if (msg.method === "session/update" && this.turn) {
      handleUpdate((params.update ?? {}) as Json, this.turn.turn, this.turn.state);
    } else if (msg.method === "session/request_permission") {
      void this.permission(msg.id, params);
    } else if (msg.id !== undefined && msg.method) {
      // A request we don't serve (file system, terminal): we told the agent we can't.
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

  private async start(launch: AcpLaunch, cwd: string): Promise<void> {
    this.stop();
    this.stderr = [];
    const { command } = launch;
    const child = spawnCommand(command, launch.args, { cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
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
      failAll(startError(this.engine, command, err));
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.forget();
      failAll(new Error(`${this.label} exited (${code}): ${this.stderr.join("").trim().slice(-800) || "no output"}`));
    });
    await this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  }

  private get label() {
    return this.engine === "hermes" ? "Hermes" : "OpenCode";
  }

  /** One message. Starts (or restarts) the agent when how it's launched, or the folder, changed;
   * `key` is what identifies the launch (its command and setup). */
  async run(turn: EngineTurn, launch: AcpLaunch, key: string): Promise<EngineResult> {
    const full = JSON.stringify([key, turn.cwd]);
    if (!this.child || full !== this.key) {
      await this.start(launch, turn.cwd);
      this.key = full;
    }
    let prompt = turn.prompt;
    if (!this.sessionId) {
      const created = await this.call("session/new", { cwd: turn.cwd, mcpServers: launch.mcpServers ?? [] });
      this.sessionId = String(created.sessionId);
      if (launch.intro) prompt = `${launch.intro}\n\n---\n\n${prompt}`;
    }
    const sessionId = this.sessionId;
    const state = { text: "", tools: new Map<string, string>() };
    this.turn = { turn, state };
    const cancel = () => this.send({ method: "session/cancel", params: { sessionId } });
    turn.signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
      if (result.stopReason === "refusal") throw new Error(`${this.label}'s model refused this request.`);
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
    this.failWaiting(new Error(`${this.label} was stopped.`));
    child?.kill();
  }
}

/** A JSON-RPC error as something to read: ACP agents put the real cause in `data` ("Internal error"
 * alone says nothing), with the end of the agent's own log when there's no more to go on. */
export function errorText(label: string, error: Json, stderr: string[] = []): string {
  const message = String(error.message ?? "error");
  const data = error.data as Json | string | undefined;
  const details = typeof data === "string" ? data : data && typeof data === "object" ? (typeof data.details === "string" ? data.details : JSON.stringify(data)) : "";
  if (details) return `${label}: ${details}`;
  const log = stderr.join("").trim().split("\n").slice(-6).join("\n");
  return log ? `${label}: ${message}\n${log}` : `${label}: ${message}`;
}
