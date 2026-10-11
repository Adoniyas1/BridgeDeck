/**
 * The tool Claude Code calls (as --permission-prompt-tool) whenever it wants to do something that
 * needs the user's OK: run a command, change a file. Claude Code starts this as an MCP server over
 * stdio; each call is posted to Mimir (MIMIR_APPROVAL_URL, with MIMIR_APPROVAL_SECRET), which shows
 * the same Allow / Deny card as its own tools and answers with the user's choice.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const url = process.env.MIMIR_APPROVAL_URL ?? "";
const secret = process.env.MIMIR_APPROVAL_SECRET ?? "";

const server = new McpServer({ name: "mimir", version: "1.0.0" });
server.registerTool(
  "approve",
  {
    description: "Asks the Mimir user to allow a tool call.",
    inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() }
  },
  async ({ tool_name, input }) => {
    let allowed: boolean;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ tool: tool_name, input })
      });
      allowed = res.ok && ((await res.json()) as { allowed?: boolean }).allowed === true;
    } catch {
      allowed = false;
    }
    const decision = allowed ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The user didn't allow this." };
    return { content: [{ type: "text", text: JSON.stringify(decision) }] };
  }
);
await server.connect(new StdioServerTransport());
