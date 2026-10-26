import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * A small local server that speaks the Anthropic Messages API (what Claude Code talks) and passes
 * each request on to an OpenAI-compatible server (llama-swap, llama.cpp, MLX, LM Studio, Ollama's
 * /v1). Claude Code then runs on the Brain team's models without LiteLLM or another app: Mimir
 * starts it on 127.0.0.1 with a random port and secret, and points ANTHROPIC_BASE_URL at it.
 */

/** Where one request goes. */
export interface Upstream {
  /** e.g. http://192.168.1.20:8080 (no /v1). */
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  thinking?: boolean;
  /** An Ollama server (it sizes the context per request; engines/hermes.ts caps it). */
  ollama?: boolean;
}

/** Picks the server and model for the model name Claude Code asked for; throws (with a message
 * for the user) when none answers. */
export type RouteModel = (requested: string) => Promise<Upstream>;

type Json = Record<string, unknown>;
type Fetch = typeof fetch;

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<Json> | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((b: Json) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
};

/** An Anthropic Messages request as an OpenAI chat completions request. `thinking` (when set) turns
 * the model's thinking on or off through chat_template_kwargs. */
export function toOpenAIRequest(body: Json, model: string, thinking?: boolean): Json {
  const messages: OpenAIMessage[] = [];
  const system = text(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const m of (body.messages as Array<{ role: string; content: unknown }>) ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? (m.content as Json[]) : [];
    if (m.role === "assistant") {
      const said = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: String(b.id), type: "function" as const, function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: "assistant", content: said || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results first (they answer the assistant's calls), then anything else said.
    for (const b of blocks.filter((b) => b.type === "tool_result")) {
      const body = typeof b.content === "string" ? b.content : text(b.content);
      messages.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: b.is_error ? `Error: ${body}` : body });
    }
    const parts: Json[] = [];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") {
        const src = b.source as Json | undefined;
        const url = src?.type === "base64" ? `data:${String(src.media_type)};base64,${String(src.data)}` : src?.type === "url" ? String(src.url) : null;
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
    }
    if (parts.length) {
      const onlyText = parts.every((p) => p.type === "text");
      messages.push({ role: "user", content: onlyText ? parts.map((p) => String(p.text)).join("\n") : parts });
    }
  }

  const tools = ((body.tools as Json[] | undefined) ?? [])
    .filter((t) => t.input_schema && typeof t.name === "string")
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));

  const out: Json = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (thinking !== undefined) out.chat_template_kwargs = { enable_thinking: thinking };
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (tools.length) {
    out.tools = tools;
    const choice = body.tool_choice as Json | undefined;
    if (choice?.type === "any") out.tool_choice = "required";
    else if (choice?.type === "none") out.tool_choice = "none";
    else if (choice?.type === "tool") out.tool_choice = { type: "function", function: { name: choice.name } };
  }
  return out;
}

const STOP_REASONS: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "end_turn" };

/** Turns an OpenAI chat completions stream into Anthropic Messages stream events. Feed it each
 * parsed chunk; it calls `emit(event, data)` in the order Claude Code expects. */
export class StreamTranslator {
  private index = -1;
  private open: { kind: "text" } | { kind: "tool"; key: number } | null = null;
  private toolBlocks = new Map<number, number>();
  private stopReason = "end_turn";
  private sawTool = false;
  private outputTokens = 0;
  private inputTokens = 0;
  private started = false;

  constructor(
    private model: string,
    private emit: (event: string, data: Json) => void,
    private id = `msg_${randomBytes(12).toString("hex")}`
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.emit("message_start", {
      type: "message_start",
      message: { id: this.id, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    });
  }

  private close(): void {
    if (this.open) this.emit("content_block_stop", { type: "content_block_stop", index: this.index });
    this.open = null;
  }

  chunk(data: Json): void {
    this.start();
    const usage = data.usage as Json | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === "number") this.inputTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") this.outputTokens = usage.completion_tokens;
    }
    const choice = (data.choices as Json[] | undefined)?.[0];
    if (!choice) return;
    const delta = (choice.delta ?? {}) as Json;
    if (typeof delta.content === "string" && delta.content) {
      if (this.open?.kind !== "text") {
        this.close();
        this.index++;
        this.open = { kind: "text" };
        this.emit("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } });
      }
      this.emit("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: delta.content } });
    }
    for (const call of (delta.tool_calls as Json[] | undefined) ?? []) {
      const key = typeof call.index === "number" ? call.index : 0;
      const fn = (call.function ?? {}) as Json;
      if (!this.toolBlocks.has(key)) {
        this.close();
        this.index++;
        this.toolBlocks.set(key, this.index);
        this.open = { kind: "tool", key };
        this.sawTool = true;
        const id = typeof call.id === "string" && call.id ? call.id : `toolu_${randomBytes(8).toString("hex")}`;
        this.emit("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "tool_use", id, name: String(fn.name ?? ""), input: {} } });
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        this.emit("content_block_delta", { type: "content_block_delta", index: this.toolBlocks.get(key)!, delta: { type: "input_json_delta", partial_json: fn.arguments } });
      }
    }
    if (typeof choice.finish_reason === "string") this.stopReason = STOP_REASONS[choice.finish_reason] ?? "end_turn";
  }

  finish(): void {
    this.start();
    this.close();
    // Some servers end a tool call with "stop"; the call is what matters.
    const stop = this.sawTool ? "tool_use" : this.stopReason;
    this.emit("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } });
    this.emit("message_stop", { type: "message_stop" });
  }
}

/** Reads `data:` lines from an SSE body. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(piece, { stream: true });
    let at: number;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).replace(/\r$/, "");
      buf = buf.slice(at + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith("data:")) yield buf.slice(5).trim();
}

/** A rough token count (about four characters a token), for /v1/messages/count_tokens. */
export function estimateTokens(body: Json): number {
  return Math.ceil(JSON.stringify({ s: body.system, m: body.messages, t: body.tools }).length / 4);
}

function errorBody(message: string, type = "api_error"): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

export interface AnthropicBridge {
  url: string;
  secret: string;
  close(): Promise<void>;
}

/** Starts the bridge on 127.0.0.1 (random port). Requests must carry the secret as the API key. */
export async function startAnthropicBridge(route: RouteModel, fetchImpl: Fetch = fetch): Promise<AnthropicBridge> {
  const secret = randomBytes(24).toString("hex");
  const expected = Buffer.from(secret);
  const authorized = (req: http.IncomingMessage) => {
    const given = String(req.headers["x-api-key"] ?? "") || String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const got = Buffer.from(given);
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(errorBody(err instanceof Error ? err.message : String(err)));
    });
  });

  async function readJson(req: http.IncomingMessage): Promise<Json> {
    let raw = "";
    for await (const piece of req) raw += piece;
    return raw ? (JSON.parse(raw) as Json) : {};
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(errorBody("Wrong key for Mimir's model bridge.", "authentication_error"));
      return;
    }
    if (req.method === "GET" && path === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [], has_more: false }));
      return;
    }
    if (req.method !== "POST" || !path?.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(errorBody(`Mimir's model bridge doesn't serve ${req.method} ${path}.`, "not_found_error"));
      return;
    }
    const body = await readJson(req);
    if (path === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
      return;
    }

    let upstream: Upstream;
    try {
      upstream = await route(String(body.model ?? ""));
    } catch (err) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(errorBody(err instanceof Error ? err.message : String(err), "overloaded_error"));
      return;
    }

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let reply: Response;
    try {
      reply = await fetchImpl(`${upstream.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(upstream.apiKey ? { authorization: `Bearer ${upstream.apiKey}` } : {}) },
        body: JSON.stringify(toOpenAIRequest(body, upstream.model, upstream.thinking)),
        signal: abort.signal
      });
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(errorBody(`${upstream.baseUrl} isn't answering (${err instanceof Error ? err.message : String(err)}).`));
      return;
    }
    if (!reply.ok || !reply.body) {
      const detail = await reply.text().catch(() => "");
      res.writeHead(reply.status >= 400 && reply.status < 500 ? 400 : 502, { "content-type": "application/json" });
      res.end(errorBody(`${upstream.baseUrl} answered ${reply.status}: ${detail.slice(0, 500)}`, reply.status === 400 ? "invalid_request_error" : "api_error"));
      return;
    }

    const streaming = body.stream === true;
    const model = String(body.model ?? upstream.model);
    if (streaming) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const t = new StreamTranslator(model, (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      t.start();
      for await (const data of sseData(reply.body)) {
        if (data === "[DONE]") break;
        if (data) t.chunk(JSON.parse(data) as Json);
      }
      t.finish();
      res.end();
      return;
    }

    // Not streaming: gather the same events into one message.
    const content: Json[] = [];
    let stopReason = "end_turn";
    let usage: Json = { input_tokens: 0, output_tokens: 0 };
    const partial = new Map<number, string>();
    const t = new StreamTranslator(model, (event, data) => {
      if (event === "content_block_start") content[data.index as number] = { ...(data.content_block as Json) };
      else if (event === "content_block_delta") {
        const d = data.delta as Json;
        const block = content[data.index as number]!;
        if (d.type === "text_delta") block.text = String(block.text ?? "") + String(d.text);
        else partial.set(data.index as number, (partial.get(data.index as number) ?? "") + String(d.partial_json));
      } else if (event === "message_delta") {
        stopReason = String((data.delta as Json).stop_reason);
        usage = data.usage as Json;
      }
    });
    for await (const data of sseData(reply.body)) {
      if (data === "[DONE]") break;
      if (data) t.chunk(JSON.parse(data) as Json);
    }
    t.finish();
    for (const [i, json] of partial) {
      try {
        content[i]!.input = JSON.parse(json);
      } catch {
        content[i]!.input = {};
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg_${randomBytes(12).toString("hex")}`, type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_sequence: null, usage }));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
