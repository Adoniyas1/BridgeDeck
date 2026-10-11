import { sseLines } from "../brain/openaiCompatibleProvider.js";
import type { ChatGptMessage } from "../../shared/types.js";

/**
 * The ChatGPT section talks to OpenAI's API directly with the user's own key.
 * It is not Mimir's brain (no tools, no self-editing): just ChatGPT's models in
 * a chat of their own. Chat Completions is used rather than a vendor SDK, like
 * brain/openaiCompatibleProvider.ts; no token limit is sent, since newer models
 * reject `max_tokens`.
 */
export const OPENAI_BASE = "https://api.openai.com";

export interface ChatGptRequest {
  apiKey: string;
  model: string;
  instructions: string;
  messages: ChatGptMessage[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Yields the reply's text as it arrives; throws with a readable message on failure. */
export async function* streamChatGpt(req: ChatGptRequest): AsyncGenerator<string, void, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.instructions.trim()) messages.push({ role: "system", content: req.instructions.trim() });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });

  let res: Response;
  try {
    res = await (req.fetchImpl ?? fetch)(`${OPENAI_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({ model: req.model, stream: true, messages }),
      signal: req.signal
    });
  } catch (error) {
    if (req.signal?.aborted) throw error;
    throw new Error(`Could not reach OpenAI (is this computer online?): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!res.ok) throw new Error(await describeFailure(res));
  if (!res.body) throw new Error("OpenAI sent an empty reply.");

  for await (const line of sseLines(res.body)) {
    if (line === "[DONE]") break;
    let chunk: { choices?: Array<{ delta?: { content?: string } }>; error?: { message?: string } };
    try {
      chunk = JSON.parse(line) as typeof chunk;
    } catch {
      continue;
    }
    if (chunk.error?.message) throw new Error(chunk.error.message);
    const text = chunk.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

/** Chat models this key can use, newest names first. */
export async function listChatGptModels(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${OPENAI_BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(await describeFailure(res));
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? [])
    .map((m) => m.id ?? "")
    .filter(isChatModel)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

/** Text chat models only: the list also holds embeddings, speech, images and realtime models. */
export function isChatModel(id: string): boolean {
  if (!/^(gpt-|o\d|chatgpt-)/.test(id)) return false;
  return !/(audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation|codex|computer-use|deep-research)/.test(id);
}

async function describeFailure(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
  } catch {
    // not JSON; keep the raw text
  }
  if (res.status === 401) return "OpenAI didn't accept the API key. Check it at platform.openai.com/api-keys.";
  if (res.status === 429) {
    return `OpenAI refused for now (rate limit or no credit). API use is billed separately from a ChatGPT Plus plan. ${detail}`.trim();
  }
  return `OpenAI answered ${res.status}: ${detail}`;
}
