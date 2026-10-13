import type { BrainMessage, BrainProvider, StopReason, ToolDef, ToolResult } from "../brain/Provider.js";
import type { EffortLevel } from "../../shared/types.js";

export interface AgentLoopOptions {
  provider: BrainProvider;
  system: string;
  tools: ToolDef[];
  handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>>;
  /** Hard ceiling on tool-call round-trips per user turn, so a confused
   *  model (especially a shimmed local one) can't loop forever. */
  maxToolIterations?: number;
  effort?: EffortLevel;
  webSearchEnabled?: boolean;
}

export type AgentStreamEvent =
  | { type: "text"; text: string }
  /** The model's thinking before or between its words, for the chat to show folded (never fed back). */
  | { type: "thinking"; text: string }
  | { type: "tool-start"; name: string }
  | { type: "tool-end"; name: string; isError: boolean }
  /** A tool result carried images (see ToolResult.images) — shown to the
   * user directly, never fed back into the model's own conversation. */
  | { type: "tool-image"; dataUrl: string }
  | { type: "turn-done" }
  | { type: "error"; message: string };

/** The note sent with images a tool returned for the model to see (ToolResult.modelImages). */
export const TOOL_IMAGES_NOTE = "[Image from the tool call above]";

/**
 * Drives one user turn to completion: sends the conversation to the active
 * BrainProvider, executes any tool calls it requests via the provided
 * handlers, feeds results back, and repeats until the model stops calling
 * tools or the iteration cap is hit. Provider-agnostic — works identically
 * whether `provider` is Claude, a local Ollama model, or a VPS endpoint.
 */
export async function* runAgentTurn(
  history: BrainMessage[],
  opts: AgentLoopOptions
): AsyncGenerator<AgentStreamEvent, BrainMessage[], unknown> {
  const messages = [...history];
  const maxIterations = opts.maxToolIterations ?? 8;
  const tools = opts.provider.supportsTools() ? opts.tools : [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let assistantText = "";
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let stopReason: StopReason = "end_turn";
    let sawError = false;

    for await (const ev of opts.provider.chat(messages, tools, {
      system: opts.system,
      effort: opts.effort,
      webSearchEnabled: opts.webSearchEnabled
    })) {
      if (ev.type === "text-delta") {
        assistantText += ev.text;
        yield { type: "text", text: ev.text };
      } else if (ev.type === "reasoning-delta") {
        yield { type: "thinking", text: ev.text };
      } else if (ev.type === "tool-call") {
        toolCalls.push(ev.call);
      } else if (ev.type === "error") {
        sawError = true;
        yield { type: "error", message: ev.message };
      } else if (ev.type === "done") {
        stopReason = ev.stopReason;
      }
    }

    if (sawError) return messages;

    messages.push({
      role: "assistant",
      content: assistantText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    });

    if (toolCalls.length === 0 || stopReason !== "tool_use") {
      yield { type: "turn-done" };
      return messages;
    }

    const seen: Array<{ mimeType: string; data: string }> = [];
    for (const call of toolCalls) {
      yield { type: "tool-start", name: call.name };
      const handler = opts.handlers[call.name];
      let result: ToolResult;
      if (!handler) {
        result = { content: `Unknown tool: ${call.name}`, isError: true };
      } else {
        try {
          result = await handler(call.input);
        } catch (err) {
          result = { content: err instanceof Error ? err.message : String(err), isError: true };
        }
      }
      yield { type: "tool-end", name: call.name, isError: result.isError ?? false };
      for (const img of result.images ?? []) {
        yield { type: "tool-image", dataUrl: `data:image/png;base64,${img}` };
      }
      messages.push({
        role: "tool",
        content: result.content,
        toolCallId: call.id,
        isError: result.isError
      });
      seen.push(...(result.modelImages ?? []));
    }
    if (seen.length) {
      // Only the newest screenshots stay in the conversation.
      for (const m of messages) {
        if (m.role === "user" && m.content.startsWith(TOOL_IMAGES_NOTE) && m.attachments?.length) {
          m.attachments = undefined;
          m.content = `${TOOL_IMAGES_NOTE} (an older image, no longer attached)`;
        }
      }
      messages.push({
        role: "user",
        content: TOOL_IMAGES_NOTE,
        attachments: seen.slice(0, 4).map((img, i) => ({ kind: "image" as const, mimeType: img.mimeType, data: img.data, name: `tool-image-${i + 1}` }))
      });
    }
  }

  yield {
    type: "error",
    message: `Stopped after ${maxIterations} tool-call rounds without finishing — the model may be stuck.`
  };
  return messages;
}
