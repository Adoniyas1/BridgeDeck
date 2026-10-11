#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json` in tests. It records its arguments and
// environment, asks for permission through the --mcp-config server (the real approval tool), and
// prints stream-json the way Claude Code does.
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
if (args.includes("--help")) {
  console.log('--permission-mode <mode>  (choices: "acceptEdits", "auto", "manual", "plan")');
  process.exit(0);
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (process.env.FAKE_CLAUDE_RECORD) {
  writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, prompt, cwd: process.cwd(), env: { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null, ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null } }));
}
const session = flag("--resume") ?? "sess-1";
out({ type: "system", subtype: "init", session_id: session });
if (prompt.includes("fail")) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "the model server is off", session_id: session });
  process.exit(1);
}

// Ask the approval tool, as Claude Code does before running a command.
const { mcpServers } = JSON.parse(readFileSync(flag("--mcp-config"), "utf8"));
const server = mcpServers.mimir;
// The tests point it at the TypeScript source; tsx is resolved from here, not the temp folder.
const serverArgs = server.args[0].endsWith(".ts") ? ["--import", import.meta.resolve("tsx"), ...server.args] : server.args;
const client = new Client({ name: "fake-claude", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: server.command, args: serverArgs, env: { ...process.env, ...server.env } }));
const [, tool] = flag("--permission-prompt-tool").split("__").slice(1);
const answer = await client.callTool({ name: tool, arguments: { tool_name: "Bash", input: { command: "touch made.txt", description: "Make a file" } } });
const decision = JSON.parse(answer.content[0].text);
await client.close();

out({ type: "stream_event", session_id: session, event: { type: "message_start" } });
out({ type: "stream_event", session_id: session, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Making it." } } });
out({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: "Making it." }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "touch made.txt" } }] } });
const allowed = decision.behavior === "allow";
if (allowed) writeFileSync("made.txt", "");
out({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: !allowed, content: allowed ? "" : decision.message }] } });
// The last message arrives whole (no deltas), as when partial messages are off.
const final = allowed ? "Made it." : "You didn't allow it.";
out({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: final }] } });
out({ type: "result", subtype: "success", is_error: false, result: final, session_id: session });
