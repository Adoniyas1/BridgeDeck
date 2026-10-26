import http from "node:http";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { serverPath } from "../mcp/manager.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { preview, type Approver } from "../approvals.js";
import { getBrainApiKey, loadBrainConfig } from "../brain/config.js";
import { normalizeBaseUrl } from "../brain/baseUrl.js";
import { resolveRole } from "../team/endpoints.js";
import { guardEndpoint } from "../setup/memory.js";
import type { BrainRole, TeamConfig } from "../../shared/types.js";
import type { Upstream } from "./anthropicBridge.js";

/** What an outside agent (Claude Code, OpenCode) reports during a turn, in Mimir's terms. */
export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-end"; id: string; name: string; isError: boolean };

export interface EngineTurn {
  prompt: string;
  /** The folder the agent works in (the coding folder). */
  cwd: string;
  /** Changes inside this folder are allowed without asking. */
  projectsRoot: string;
  approve: Approver;
  emit: (event: EngineEvent) => void;
  signal: AbortSignal;
  /** What Mimir knows about the user, for agents that keep their own conversations (Hermes). */
  intro?: string;
  /** Mimir's own tools (calendar, notes, study…), given to the agent over MCP (engines/tools.ts). */
  tools?: import("./tools.js").Toolset;
}

export interface EngineResult {
  text: string;
}

const ENGINE_NAMES = { "claude-code": "Claude Code", opencode: "OpenCode", hermes: "Hermes" } as const;
export type EngineName = keyof typeof ENGINE_NAMES;
export const engineName = (engine: keyof typeof ENGINE_NAMES) => ENGINE_NAMES[engine];

/** The card text for one tool call an agent wants to make. Tool names differ between agents
 * (Bash / bash, Edit / edit), so match loosely. */
export function describeToolCall(tool: string, input: Record<string, unknown>): { title: string; detail: string } {
  const name = tool.toLowerCase();
  const file = String(input.file_path ?? input.filePath ?? input.path ?? "");
  if (name === "bash" || name === "execute" || name === "shell") {
    const command = String(input.command ?? "");
    return { title: "Run a command", detail: input.description ? `${String(input.description)}\n\n${command}` : command };
  }
  if (name === "write") return { title: `Write ${file || "a file"}`, detail: preview(input.content ?? input) };
  if (name === "edit" || name === "multiedit" || name === "notebookedit" || name === "patch") {
    const change = input.old_string !== undefined || input.oldString !== undefined
      ? `- ${String(input.old_string ?? input.oldString)}\n+ ${String(input.new_string ?? input.newString)}`
      : preview(input);
    return { title: `Change ${file || "a file"}`, detail: preview(change) };
  }
  if (name === "webfetch" || name === "fetch") return { title: "Fetch a web page", detail: String(input.url ?? preview(input)) };
  return { title: `Use ${tool}`, detail: preview(input) };
}

/** The server and model a role uses right now, as an OpenAI-compatible upstream: the PC first,
 * then the fallback (team/endpoints.ts). */
export async function roleUpstream(team: TeamConfig, role: BrainRole): Promise<Upstream> {
  // One model does everything: that's the Brain (Settings → Brain), not the team's roles.
  if (team.mode === "single") return brainUpstream(team);
  const status = await resolveRole(team, role);
  const label = role === "head" ? "Head" : role === "executor" ? "Executor" : "Checker";
  if (!status.reachable || !status.endpoint) throw new Error(`The ${label} model can't be reached: ${status.detail}.`);
  const e = status.endpoint;
  await guardEndpoint(e);
  if (e.provider === "anthropic") {
    throw new Error(`The ${label} is set to Anthropic. Choose “its own models” for this agent to use your Anthropic login, or point the ${label} at a local server.`);
  }
  const baseUrl = normalizeBaseUrl(e.baseUrl) ?? "http://localhost:11434";
  const apiKey = e.provider === "openai-compatible" ? await getBrainApiKey("openai-compatible").catch(() => null) : null;
  return { baseUrl, model: e.model, apiKey, thinking: team.thinking, ollama: e.provider === "ollama" };
}

/** The Brain's one model, for an agent when Mimir is set to one model. */
async function brainUpstream(team: TeamConfig): Promise<Upstream> {
  const brain = await loadBrainConfig();
  if (brain.provider === "anthropic") {
    throw new Error("The Brain is set to Claude. Choose “its own models” for this agent to use your Anthropic login, or set the Brain to Ollama or a local server.");
  }
  const baseUrl = normalizeBaseUrl(brain.baseUrl) ?? "http://localhost:11434";
  const apiKey = brain.provider === "openai-compatible" ? await getBrainApiKey("openai-compatible").catch(() => null) : null;
  return { baseUrl, model: brain.model, apiKey, thinking: team.thinking, ollama: brain.provider === "ollama" };
}

/** The role an agent's model name stands for: small/fast models are the Executor. */
export const roleForModel = (model: string): BrainRole => (/executor|haiku|small/i.test(model) ? "executor" : "head");

export interface ApprovalEndpoint {
  url: string;
  secret: string;
  close(): Promise<void>;
}

/** A one-turn local endpoint the Claude Code approval tool posts to (engines/approvalServer.ts). */
export async function startApprovalEndpoint(approve: Approver): Promise<ApprovalEndpoint> {
  const secret = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Bearer ${secret}`);
  const server = http.createServer((req, res) => {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (req.method !== "POST" || got.length !== expected.length || !timingSafeEqual(got, expected)) {
      res.writeHead(401).end();
      return;
    }
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      void (async () => {
        let allowed: boolean;
        try {
          const { tool, input } = JSON.parse(raw) as { tool: string; input: Record<string, unknown> };
          allowed = await approve({ tool, ...describeToolCall(tool, input ?? {}) });
        } catch {
          allowed = false;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ allowed }));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/approve`, secret, close: () => new Promise((r) => server.close(() => r())) };
}

/** Starts an agent's command. On Windows it goes through the shell (npm installs `claude.cmd` and
 * `opencode.cmd`), so anything with spaces is quoted. */
export function spawnCommand(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const env = { ...(options.env ?? process.env) };
  env.PATH = serverPath(env.PATH);
  if (process.platform !== "win32") return spawn(command, args, { ...options, env });
  const quote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return spawn(quote(command), args.map(quote), { ...options, env, shell: true, windowsHide: true });
}

/** A friendly error for a command that couldn't start. */
export function startError(engine: keyof typeof ENGINE_NAMES, command: string, err: NodeJS.ErrnoException): Error {
  if (err.code === "ENOENT") {
    const how = engine === "claude-code" ? "npm install -g @anthropic-ai/claude-code" : engine === "hermes" ? "from hermes-agent.nousresearch.com, with its ACP extra; check with hermes acp --check" : "npm install -g opencode-ai";
    return new Error(`${engineName(engine)} isn't installed, or “${command}” isn't on PATH. Install it (${how}) or set its path in Settings → Brain team.`);
  }
  return new Error(`${engineName(engine)} couldn't start: ${err.message}`);
}

/** Whether an agent's command runs, and its version. */
export function checkEngine(engine: keyof typeof ENGINE_NAMES, command: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawnCommand(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, detail: `“${command} --version” didn't answer.` });
    }, 15_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: startError(engine, command, err).message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const version = out.trim().split("\n")[0] ?? "";
      resolve(code === 0 ? { ok: true, detail: `${engineName(engine)} ${version}`.trim() } : { ok: false, detail: `“${command} --version” exited ${code}.` });
    });
  });
}
