/**
 * Mimir's own tools (BridgeDeck's calendar, notes, study, messages and files; memory; projects) for
 * an outside agent (Hermes, Claude Code, OpenCode). The agent starts this as an MCP server over
 * stdio; it lists and calls the tools through Mimir (MIMIR_TOOLS_URL, with MIMIR_TOOLS_SECRET), so
 * the tools run in Mimir as they do for its own model, approvals and all.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const url = (process.env.MIMIR_TOOLS_URL ?? "").replace(/\/+$/, "");
const secret = process.env.MIMIR_TOOLS_SECRET ?? "";

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`Mimir answered ${res.status}`);
  return res.json();
}

const server = new Server({ name: "mimir", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await post("/tools", {})) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = (await post("/call", { name: request.params.name, input: request.params.arguments ?? {} })) as { content: string; isError?: boolean; images?: Array<{ mimeType: string; data: string }> };
    return {
      content: [{ type: "text" as const, text: result.content }, ...(result.images ?? []).map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: i.data }))],
      isError: result.isError === true
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Mimir couldn't run ${request.params.name}: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
