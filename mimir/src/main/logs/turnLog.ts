import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MIMIR_HOME } from "../config/store.js";
import { todayISO } from "../persona/paths.js";
import type { BrainMessage, BrainProvider, ChatEvent, ChatOpts, ToolDef, ToolResult } from "../brain/Provider.js";

/**
 * A plain record of each chat turn in ~/.mimir/logs/<date>.md, for finding out why a turn was slow
 * or failed: which model each call went to, how long it took and how big its prompt was, the tools
 * it called and what they returned, memory in use, and the reply or error. Lines are appended as the
 * turn goes, so a turn cut short by a crash still leaves its trail. Kept for 30 days.
 */

export const LOG_DIR = path.join(MIMIR_HOME, "logs");
const KEEP_DAYS = 30;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} … (+${text.length - max} chars)` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const time = () => new Date().toTimeString().slice(0, 8);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
/** About four characters a token. */
const tokens = (text: string) => Math.ceil(text.length / 4);

export function memoryInUse(): string {
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  return `${gb(os.totalmem() - os.freemem())}/${gb(os.totalmem())} GB memory in use`;
}

export class TurnLog {
  private file: string;
  private queue: Promise<void> = Promise.resolve();
  private began = Date.now();

  constructor(mode: string, userText: string, private dir: string = LOG_DIR) {
    this.file = path.join(dir, `${todayISO()}.md`);
    this.write(`\n## ${time()} · ${mode}\n\n- message: ${clip(oneLine(userText), 500)}\n- ${memoryInUse()}`);
  }

  /** Appends in order. Logging never fails a turn. */
  write(line: string): void {
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(this.file, `${line}\n`, "utf-8");
      })
      .catch(() => undefined);
  }

  note(text: string): void {
    this.write(`- ${time()} ${text}`);
  }

  finish(result: { reply?: string; error?: string }): Promise<void> {
    const took = secs(Date.now() - this.began);
    this.write(result.error ? `- ${time()} **error** after ${took}: ${clip(oneLine(result.error), 1000)}` : `- ${time()} done in ${took}, reply ≈ ${tokens(result.reply ?? "")} tokens`);
    return this.queue;
  }

  /** The same provider; each call is logged under `label` (e.g. "Head"). */
  provider(inner: BrainProvider, label: string): BrainProvider {
    const write = (line: string) => this.write(line);
    return {
      kind: inner.kind,
      model: inner.model,
      supportsTools: () => inner.supportsTools(),
      supportsVision: () => inner.supportsVision(),
      async *chat(messages: BrainMessage[], tools: ToolDef[], opts: ChatOpts): AsyncGenerator<ChatEvent, void, unknown> {
        const start = Date.now();
        const prompt = tokens(opts.system) + messages.reduce((n, m) => n + tokens(m.content), 0) + tokens(JSON.stringify(tools));
        let first: number | null = null;
        let replyTokens = 0;
        let thinkingTokens = 0;
        let ending = "stopped";
        const calls: string[] = [];
        try {
          for await (const ev of inner.chat(messages, tools, opts)) {
            if (first === null && (ev.type === "text-delta" || ev.type === "reasoning-delta" || ev.type === "tool-call")) first = Date.now();
            if (ev.type === "text-delta") replyTokens += tokens(ev.text);
            else if (ev.type === "reasoning-delta") thinkingTokens += tokens(ev.text);
            else if (ev.type === "tool-call") calls.push(ev.call.name);
            else if (ev.type === "error") ending = `error: ${clip(oneLine(ev.message), 500)}`;
            else if (ev.type === "done" && !ending.startsWith("error")) ending = ev.stopReason;
            yield ev;
          }
        } finally {
          write(
            `- ${time()} **${label}** ${inner.model}: ${secs(Date.now() - start)}` +
              (first ? ` (first output after ${secs(first - start)})` : "") +
              ` · prompt ≈ ${prompt} tokens, ${tools.length} tools · reply ≈ ${replyTokens} tokens` +
              (thinkingTokens ? ` · thinking ≈ ${thinkingTokens} tokens` : "") +
              (calls.length ? ` · calls ${calls.join(", ")}` : "") +
              ` · ${ending}`
          );
        }
      }
    };
  }

  /** The same tool handlers; each run is logged with a short look at its result. */
  handlers<T extends Record<string, (input: Record<string, unknown>) => Promise<ToolResult>>>(inner: T): T {
    const out: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>> = {};
    for (const [name, fn] of Object.entries(inner)) {
      out[name] = async (input) => {
        const start = Date.now();
        try {
          const result = await fn(input);
          this.write(`- ${time()} tool ${name}(${clip(oneLine(JSON.stringify(input)), 300)}) ${result.isError ? "failed" : "ok"} in ${secs(Date.now() - start)}: ${clip(oneLine(result.content), 400)}`);
          return result;
        } catch (err) {
          this.write(`- ${time()} tool ${name} threw: ${clip(oneLine(err instanceof Error ? err.message : String(err)), 400)}`);
          throw err;
        }
      };
    }
    return out as T;
  }
}

/** Removes day logs older than 30 days. */
export async function pruneLogs(dir: string = LOG_DIR, now = Date.now()): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      const day = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)?.[1];
      if (day && now - Date.parse(day) > KEEP_DAYS * 86_400_000) await rm(path.join(dir, name), { force: true });
    }
  } catch {
    /* no logs yet */
  }
}
