import http from "node:http";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { ToolDef, ToolResult } from "../brain/Provider.js";

/** The stdio MCP server script an agent starts to reach Mimir's tools (toolsServer.ts). */
export const TOOLS_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "toolsServer.js");

export interface Toolset {
  defs: ToolDef[];
  handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>>;
}

/**
 * Where an outside agent's tool calls come in: a local HTTP endpoint (127.0.0.1, a random port, a
 * secret) that lists and runs the tools Mimir gives this turn. It lives as long as the engines do,
 * since an agent keeps its MCP servers for the whole conversation; each turn swaps the tools in.
 */
export class ToolsEndpoint {
  private server: http.Server | null = null;
  private secret = randomBytes(24).toString("hex");
  private url = "";
  private tools: Toolset = { defs: [], handlers: {} };

  set(tools: Toolset): void {
    this.tools = tools;
  }

  private authorized(req: http.IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${this.secret}`);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  private async answer(route: string, body: Record<string, unknown>): Promise<unknown> {
    if (route === "/tools") return this.tools.defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }));
    if (route === "/call") {
      const name = String(body.name ?? "");
      const handler = this.tools.handlers[name];
      if (!handler) return { content: `There's no tool called ${name} right now.`, isError: true };
      const input = body.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
      try {
        const result = await handler(input);
        return { content: result.content, isError: result.isError === true, images: result.modelImages ?? [] };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    }
    throw new Error("not found");
  }

  /** Starts the endpoint once; the address and secret an agent's MCP server needs. */
  async start(): Promise<{ url: string; secret: string }> {
    if (!this.server) {
      const server = http.createServer((req, res) => {
        if (req.method !== "POST" || !this.authorized(req)) {
          res.writeHead(401).end();
          return;
        }
        let raw = "";
        req.on("data", (c: Buffer) => {
          raw += c.toString();
          if (raw.length > 4_000_000) req.destroy();
        });
        req.on("end", () => {
          void (async () => {
            try {
              const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
              const out = await this.answer(String(req.url ?? ""), body);
              res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
            } catch {
              res.writeHead(404).end();
            }
          })();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      this.server = server;
      this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    return { url: this.url, secret: this.secret };
  }

  /** The MCP server entry for ACP's session/new (OpenCode, Hermes). */
  async acpServer(): Promise<Record<string, unknown>> {
    const { url, secret } = await this.start();
    return { name: "mimir", command: process.execPath, args: [TOOLS_SERVER], env: [{ name: "MIMIR_TOOLS_URL", value: url }, { name: "MIMIR_TOOLS_SECRET", value: secret }] };
  }

  /** The MCP server entry for Claude Code's --mcp-config. */
  async claudeServer(): Promise<Record<string, unknown>> {
    const { url, secret } = await this.start();
    return { command: process.execPath, args: [TOOLS_SERVER], env: { MIMIR_TOOLS_URL: url, MIMIR_TOOLS_SECRET: secret } };
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }
}
