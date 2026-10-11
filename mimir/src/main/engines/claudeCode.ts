import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "../coding/tools.js";
import type { TeamConfig } from "../../shared/types.js";
import { startAnthropicBridge, type AnthropicBridge, type RouteModel } from "./anthropicBridge.js";
import { roleForModel, roleUpstream, spawnCommand, startApprovalEndpoint, startError, type EngineResult, type EngineTurn } from "./common.js";

/**
 * Claude Code, headless, as Mimir's agent: `claude -p --output-format stream-json`. Its own tools
 * (Read, Edit, Bash, …) do the work; every permission prompt comes back to Mimir through a small MCP
 * tool (approvalServer.ts) and shows as an Allow / Deny card. With the team's models, Claude Code
 * talks to Mimir's Anthropic-to-OpenAI bridge, which sends "opus/sonnet" to the Head and "haiku" to
 * the Executor, on the PC when it answers and on this computer when it doesn't.
 */

const APPROVAL_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "approvalServer.js");
export const HEAD_MODEL = "mimir-head";
export const EXECUTOR_MODEL = "mimir-executor";

export interface ClaudeCodeOptions {
  command: string;
  /** null: Claude Code's own models and login. */
  team: TeamConfig | null;
  /** The conversation to continue, from an earlier turn's result. */
  resume: string | null;
  /** For tests: where the bridge sends requests. */
  route?: RouteModel;
  approvalServer?: string;
}

/** Turns stream-json lines into Mimir events; returns what the turn ended with. */
export class ClaudeStreamParser {
  sessionId: string | null = null;
  result: { text: string; isError: boolean } | null = null;
  private text = "";
  /** Messages whose text already arrived as deltas (by id; a flag when ids are missing). */
  private streamed = new Set<string>();
  private streamingId: string | null = null;
  private streamedThisMessage = false;
  private tools = new Map<string, string>();

  constructor(private emit: EngineTurn["emit"]) {}

  get reply(): string {
    return this.text;
  }

  private say(text: string) {
    if (!text) return;
    this.text += text;
    this.emit({ type: "text", text });
  }

  line(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.session_id === "string") this.sessionId = msg.session_id;
    if (msg.type === "stream_event") {
      const ev = msg.event as { type?: string; delta?: { type?: string; text?: string }; message?: { id?: string } } | undefined;
      if (ev?.type === "message_start") {
        this.streamedThisMessage = false;
        this.streamingId = ev.message?.id ?? null;
      }
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        this.streamedThisMessage = true;
        if (this.streamingId) this.streamed.add(this.streamingId);
        this.say(ev.delta.text);
      }
      return;
    }
    const content = ((msg.message as { content?: unknown } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
    if (msg.type === "assistant" && Array.isArray(content)) {
      // Text already arrived as deltas when partial messages are on; this is the fallback. One API
      // message can come as several of these (a block each), so match by message id when there is one.
      const id = (msg.message as { id?: unknown }).id;
      const wasStreamed = typeof id === "string" ? this.streamed.has(id) : this.streamedThisMessage;
      if (typeof id !== "string") this.streamedThisMessage = false;
      for (const block of content) {
        if (block.type === "text" && !wasStreamed) this.say(String(block.text ?? ""));
        if (block.type === "tool_use") {
          const id = String(block.id);
          const name = String(block.name);
          this.tools.set(id, name);
          this.emit({ type: "tool-start", id, name });
        }
      }
      if (this.text && !/\n$/.test(this.text) && content.some((b) => b.type === "tool_use")) this.say("\n\n");
    } else if (msg.type === "user" && Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const id = String(block.tool_use_id);
        this.emit({ type: "tool-end", id, name: this.tools.get(id) ?? "tool", isError: block.is_error === true });
      }
    } else if (msg.type === "result") {
      this.result = { text: typeof msg.result === "string" ? msg.result : "", isError: msg.is_error === true };
    }
  }
}

const askModes = new Map<string, Promise<string>>();

/** The "ask for everything" permission mode's name: "manual" in newer builds, "default" before. */
export function askMode(command: string): Promise<string> {
  let mode = askModes.get(command);
  if (!mode) {
    mode = new Promise((resolve) => {
      let help = "";
      const child = spawnCommand(command, ["--help"], { stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => child.kill(), 15_000);
      child.stdout?.on("data", (d: Buffer) => (help += d.toString()));
      child.on("error", () => resolve("default"));
      child.on("close", () => {
        clearTimeout(timer);
        resolve(/"manual"/.test(help) ? "manual" : "default");
      });
    });
    askModes.set(command, mode);
  }
  return mode;
}

export async function runClaudeCode(turn: EngineTurn, options: ClaudeCodeOptions): Promise<EngineResult & { sessionId: string | null }> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "mimir-claude-"));
  const approvals = await startApprovalEndpoint(turn.approve);
  let bridge: AnthropicBridge | null = null;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, MCP_TOOL_TIMEOUT: "86400000" };
    // When Mimir itself was started from a Claude Code terminal, don't let the child think it's nested.
    delete env.CLAUDECODE;
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (options.team) {
      const team = options.team;
      bridge = await startAnthropicBridge(options.route ?? ((model) => roleUpstream(team, roleForModel(model))));
      Object.assign(env, {
        ANTHROPIC_BASE_URL: bridge.url,
        ANTHROPIC_AUTH_TOKEN: bridge.secret,
        ANTHROPIC_MODEL: HEAD_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: HEAD_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: HEAD_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: EXECUTOR_MODEL,
        ANTHROPIC_SMALL_FAST_MODEL: EXECUTOR_MODEL,
        CLAUDE_CODE_SUBAGENT_MODEL: EXECUTOR_MODEL,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
      });
      delete env.ANTHROPIC_API_KEY;
      args.push("--model", HEAD_MODEL);
    }
    const mcpConfig = path.join(scratch, "mcp.json");
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          mimir: {
            command: process.execPath,
            args: [options.approvalServer ?? APPROVAL_SERVER],
            env: { MIMIR_APPROVAL_URL: approvals.url, MIMIR_APPROVAL_SECRET: approvals.secret }
          }
        }
      })
    );
    args.push("--mcp-config", mcpConfig, "--permission-prompt-tool", "mcp__mimir__approve");
    // File changes in the Projects folder go ahead; everything else (and every command) asks. Set
    // explicitly: newer Claude Code builds default to "auto", which lets a classifier decide.
    args.push("--permission-mode", isInside(turn.projectsRoot, turn.cwd) ? "acceptEdits" : await askMode(options.command));
    if (options.resume) args.push("--resume", options.resume);

    const parser = new ClaudeStreamParser(turn.emit);
    const stderr: string[] = [];
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawnCommand(options.command, args, { cwd: turn.cwd, env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      const kill = () => child.kill("SIGTERM");
      turn.signal.addEventListener("abort", kill, { once: true });
      child.on("error", (err: NodeJS.ErrnoException) => reject(startError("claude-code", options.command, err)));
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let at: number;
        while ((at = buf.indexOf("\n")) >= 0) {
          parser.line(buf.slice(0, at));
          buf = buf.slice(at + 1);
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr.push(d.toString());
        if (stderr.length > 50) stderr.shift();
      });
      child.on("close", (code) => {
        turn.signal.removeEventListener("abort", kill);
        if (buf.trim()) parser.line(buf);
        resolve(code);
      });
      child.stdin.end(turn.prompt);
    });

    if (turn.signal.aborted) return { text: parser.reply, sessionId: parser.sessionId };
    if (parser.result?.isError) throw new Error(`Claude Code stopped: ${parser.result.text || stderr.join("").trim().slice(-800) || "no reason given"}`);
    if (!parser.result && exitCode !== 0) throw new Error(`Claude Code exited (${exitCode}): ${stderr.join("").trim().slice(-800) || "no output"}`);
    // The result repeats the last message; only use it when nothing was streamed.
    const text = parser.reply || parser.result?.text || "";
    if (!parser.reply && text) turn.emit({ type: "text", text });
    return { text, sessionId: parser.sessionId };
  } finally {
    await approvals.close();
    await bridge?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
