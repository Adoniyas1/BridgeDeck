import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDef, ToolResult, Toolset } from "../brain/Provider.js";
import type { McpServerConfig, McpServerStatus } from "../../shared/types.js";
import type { PromptModule } from "../prompts/modules.js";
import { preview, type Approver } from "../approvals.js";

/**
 * Keeps one connection per enabled MCP server and turns its tools into Mimir tools. Each server is
 * also a prompt module (`mcp:<id>`), so its tools load only when a message is about them (or a
 * team plan names the module), like any other capability.
 *
 * Tools a server marks read-only run straight away; anything else asks the user first unless the
 * server is marked trusted.
 */

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

interface Connection {
  key: string;
  state: McpServerStatus["state"];
  client: Client | null;
  tools: McpTool[];
  error: string | null;
  starting: Promise<void> | null;
}

export type TransportFactory = (server: McpServerConfig) => { transport: Transport; stderr?: () => string };

const START_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_NAME = 64;

/** PATH plus the usual install folders: an app started from the Dock doesn't get the shell's PATH,
 * so Homebrew's npx or uv's uvx would otherwise not be found. */
export function serverPath(current: string | undefined, home = os.homedir(), platform = process.platform): string {
  const sep = platform === "win32" ? ";" : ":";
  const extra = platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin")];
  const parts = (current ?? "").split(sep).filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(sep);
}

export const stdioTransport: TransportFactory = (server) => {
  const env = { ...getDefaultEnvironment(), ...server.env };
  env.PATH = serverPath(server.env.PATH ?? process.env.PATH);
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env,
    stderr: "pipe"
  });
  let tail = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-2000);
  });
  return { transport, stderr: () => tail.trim() };
};

/** The name a model calls an MCP tool by: mcp_<server>_<tool>, in the characters every provider accepts. */
export function mcpToolName(serverId: string, tool: string): string {
  return `mcp_${serverId}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME);
}

export class McpManager {
  private connections = new Map<string, Connection>();

  constructor(private transportFor: TransportFactory = stdioTransport) {}

  /** Starts enabled servers that aren't running and stops ones that were removed, disabled or
   * changed. Waits for starts, so the first message after enabling a server can use it. */
  async ensure(servers: McpServerConfig[]): Promise<void> {
    const wanted = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]));
    for (const [id, conn] of this.connections) {
      const server = wanted.get(id);
      if (!server || serverKey(server) !== conn.key) await this.stop(id);
    }
    await Promise.all([...wanted.values()].map((s) => this.start(s)));
  }

  private start(server: McpServerConfig): Promise<void> {
    const existing = this.connections.get(server.id);
    if (existing?.state === "ready" || existing?.state === "failed") return Promise.resolve();
    if (existing?.starting) return existing.starting;
    const conn: Connection = { key: serverKey(server), state: "starting", client: null, tools: [], error: null, starting: null };
    this.connections.set(server.id, conn);
    conn.starting = (async () => {
      let stderr: (() => string) | undefined;
      try {
        const made = this.transportFor(server);
        stderr = made.stderr;
        const client = new Client({ name: "mimir", version: "0.1.0" });
        await withTimeout(client.connect(made.transport), START_TIMEOUT_MS, "didn't start in time");
        const tools: McpTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          tools.push(...(page.tools as McpTool[]));
          cursor = page.nextCursor;
        } while (cursor);
        conn.client = client;
        conn.tools = tools;
        conn.state = "ready";
        client.onclose = () => {
          if (this.connections.get(server.id) === conn) {
            conn.state = "failed";
            conn.error = "The server stopped.";
            conn.client = null;
          }
        };
      } catch (err) {
        conn.state = "failed";
        const extra = stderr?.();
        const raw = err instanceof Error ? err.message : String(err);
        const message = /ENOENT/.test(raw) ? `“${server.command}” isn't installed, or isn't on PATH.` : raw;
        conn.error = `${message}${extra ? `\n${extra}` : ""}`.slice(0, 1500);
      } finally {
        conn.starting = null;
      }
    })();
    return conn.starting;
  }

  /** Forgets a failed server so the next `ensure` tries it again. */
  retry(id: string): void {
    if (this.connections.get(id)?.state === "failed") this.connections.delete(id);
  }

  private async stop(id: string): Promise<void> {
    const conn = this.connections.get(id);
    this.connections.delete(id);
    await conn?.client?.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.stop(id)));
  }

  status(servers: McpServerConfig[]): McpServerStatus[] {
    return servers.map((s) => {
      const conn = s.enabled ? this.connections.get(s.id) : undefined;
      return {
        id: s.id,
        state: conn?.state ?? "off",
        tools: (conn?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "", readOnly: t.annotations?.readOnlyHint === true })),
        error: conn?.error ?? null
      };
    });
  }

  /** The tools of every ready server, and a prompt module per server. */
  toolset(servers: McpServerConfig[], approve: Approver): Toolset & { modules: PromptModule[] } {
    const defs: ToolDef[] = [];
    const handlers: Toolset["handlers"] = {};
    const modules: PromptModule[] = [];
    for (const server of servers) {
      const conn = this.connections.get(server.id);
      if (!server.enabled || conn?.state !== "ready" || !conn.client) continue;
      const client = conn.client;
      const names: string[] = [];
      for (const tool of conn.tools) {
        const name = mcpToolName(server.id, tool.name);
        if (handlers[name]) continue;
        names.push(name);
        const readOnly = tool.annotations?.readOnlyHint === true;
        defs.push({ name, description: `${server.name}: ${tool.description ?? tool.name}`.slice(0, 1024), inputSchema: tool.inputSchema ?? { type: "object", properties: {} } });
        handlers[name] = async (input) => {
          if (!readOnly && !server.trusted) {
            const ok = await approve({ tool: name, title: `${server.name} wants to run ${tool.name}`, detail: preview(input) });
            if (!ok) return { content: "The user didn't allow this.", isError: true };
          }
          return callTool(client, tool.name, input);
        };
      }
      if (names.length) modules.push(serverModule(server, conn.tools, names));
    }
    return { defs, handlers, modules };
  }
}

function serverKey(s: McpServerConfig): string {
  return JSON.stringify([s.command, s.args, s.env]);
}

function serverModule(server: McpServerConfig, tools: McpTool[], names: string[]): PromptModule {
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = [server.name, server.id, ...server.keywords].filter(Boolean).map(escape);
  return {
    id: `mcp:${server.id}`,
    title: server.name,
    summary: `${server.name} tools: ${tools.slice(0, 6).map((t) => t.name).join(", ")}${tools.length > 6 ? ", …" : ""}`,
    when: server.keywords.length ? `You mention ${server.keywords.slice(0, 4).join(", ")}` : `You mention ${server.name}`,
    required: false,
    tiers: ["core", "full"],
    triggers: [new RegExp(`\\b(${words.join("|")})\\b`, "i")],
    text: "",
    tools: names,
    coreTools: names
  };
}

async function callTool(client: Client, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const res = (await client.callTool({ name, arguments: input }, undefined, { timeout: CALL_TIMEOUT_MS })) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }>;
      isError?: boolean;
    };
    const parts: string[] = [];
    const images: Array<{ mimeType: string; data: string }> = [];
    for (const c of res.content ?? []) {
      if (c.type === "text" && c.text !== undefined) parts.push(c.text);
      else if (c.type === "image" && c.data) {
        images.push({ mimeType: c.mimeType ?? "image/png", data: c.data });
        parts.push("[image]");
      } else if (c.type === "resource") parts.push(c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`);
      else parts.push(`[${c.type}]`);
    }
    return { content: parts.join("\n") || "(no output)", isError: res.isError === true, ...(images.length ? { modelImages: images } : {}) };
  } catch (err) {
    return { content: `The tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** The one manager for this Mimir process. */
export const mcpManager = new McpManager();
