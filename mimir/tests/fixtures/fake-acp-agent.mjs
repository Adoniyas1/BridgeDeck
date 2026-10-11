#!/usr/bin/env node
// Stands in for `opencode acp` in tests: answers ACP (JSON-RPC on stdio), asks permission before
// "running" a command, and remembers how many prompts each session got.
import { writeFileSync } from "node:fs";

if (process.argv[2] !== "acp") process.exit(2);
if (process.env.FAKE_ACP_RECORD) writeFileSync(process.env.FAKE_ACP_RECORD, process.env.OPENCODE_CONFIG_CONTENT ?? "");
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
const sessions = new Map();
const waiting = new Map();
let nextId = 100;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });

async function handle(msg) {
  if (msg.id !== undefined && !msg.method) { waiting.get(msg.id)?.(msg.result); waiting.delete(msg.id); return; }
  if (msg.method === "initialize") return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === "session/new") { const id = `ses_${sessions.size + 1}`; sessions.set(id, 0); return send({ id: msg.id, result: { sessionId: id } }); }
  if (msg.method === "session/cancel") return;
  if (msg.method === "session/prompt") {
    const { sessionId, prompt } = msg.params;
    const turn = sessions.get(sessionId) + 1;
    sessions.set(sessionId, turn);
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: `c${turn}`, title: "bash", kind: "execute", status: "pending" });
    const outcome = await ask("session/request_permission", { sessionId, toolCall: { toolCallId: `c${turn}`, title: "echo hi", kind: "execute", rawInput: { command: "echo hi" } }, options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "always", kind: "allow_always", name: "Always allow" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] });
    const allowed = outcome.outcome.optionId === "once";
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `c${turn}`, status: allowed ? "completed" : "failed" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Turn ${turn} in ${sessionId}: ${allowed ? "ran it" : "not allowed"} (${prompt[0].text}).` } });
    return send({ id: msg.id, result: { stopReason: "end_turn" } });
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "unknown" } });
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let at;
  while ((at = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, at); buf = buf.slice(at + 1); if (line.trim()) void handle(JSON.parse(line)); }
});
