// A tiny MCP server over stdio for tests: one read-only tool and one that changes things.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const notes = ["first note"];
const server = new McpServer({ name: "notes", version: "1.0.0" });
server.registerTool("list_notes", { description: "List the notes.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: notes.join("\n") }] }));
server.registerTool("add_note", { description: "Add a note.", inputSchema: { text: z.string() } }, async ({ text }) => {
  notes.push(text);
  return { content: [{ type: "text", text: `Added. ${notes.length} notes.` }] };
});
await server.connect(new StdioServerTransport());
