import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { BrainMessage, BrainProvider, ToolDef, ToolResult } from "../brain/Provider.js";
import { runAgentTurn, type AgentStreamEvent } from "../agent/loop.js";
import type { BrainRole, EffortLevel } from "../../shared/types.js";

/**
 * The Brain team's turn, as a LangGraph graph run inside Mimir's own process:
 *
 *   route ─┬─ direct ─────────────────────────────────────────────▶ end
 *          └─ plan ─▶ execute ⇄ check ─▶ … ─▶ (takeover) ─▶ answer ─▶ end
 *
 * The Head plans and writes the reply, the Executor runs one step at a time with only the tools that
 * step needs, and the Checker passes each result or sends it back (twice at most; then the Head does
 * the step itself). With `checkEachStep` off, all steps are checked together at the end, so a small
 * machine swaps models a few times per task instead of twice per step.
 */

export interface TeamStep {
  goal: string;
  modules: string[];
  done: string;
}

export interface StepResult {
  /** What the step produced: the model's last words and what its tools returned. */
  output: string;
  by: "executor" | "head";
  passed: boolean | null;
  feedback: string | null;
  attempts: number;
}

/** A role's model, ready to call, with the name shown in the chat. */
export interface TeamMember {
  provider: BrainProvider;
  model: string;
}

/** What a role gets for one call: its prompt and the tools that go with it. */
export interface RoleKit {
  system: string;
  tools: ToolDef[];
  handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>>;
}

export type TeamEvent =
  | { type: "text"; text: string }
  /** The Head's thinking while it plans or writes the reply. */
  | { type: "thinking"; text: string }
  | { type: "plan"; steps: Array<{ goal: string }> }
  | { type: "step"; index: number; status: "running" | "checking" | "passed" | "retry" | "failed" | "head"; role: BrainRole; model: string; note?: string }
  | { type: "tool-start"; name: string; step: number | null }
  | { type: "tool-end"; name: string; isError: boolean; step: number | null }
  | { type: "image"; dataUrl: string }
  | { type: "error"; message: string };

export interface TeamDeps {
  head: TeamMember;
  executor: TeamMember;
  checker: TeamMember;
  /** The conversation so far (text only), ending before this turn's message. */
  history: BrainMessage[];
  /** This turn's message as the model should see it (attachments included). */
  message: Extract<BrainMessage, { role: "user" }>;
  /** Prompt and tools for a role: `modules` names a step's modules, or null to choose from `text`. */
  kitFor: (role: BrainRole, modules: string[] | null, text: string) => Promise<RoleKit>;
  /** The modules a step may use, for the Head's plan. */
  catalog: Array<{ id: string; summary: string }>;
  /** Whether this message needs any tools at all (the module loader matched something). */
  needsTools: boolean;
  checkEachStep: boolean;
  emit: (event: TeamEvent) => void;
  cancelled: () => boolean;
  maxSteps?: number;
  maxRetries?: number;
  effort?: EffortLevel;
}

export const MAX_STEPS = 5;
export const MAX_RETRIES = 2;
/** How much of a tool's output a step's result keeps (the rest is cut). */
const TOOL_OUTPUT_CHARS = 1200;

class Cancelled extends Error {}

const State = Annotation.Root({
  path: Annotation<"direct" | "plan">(),
  steps: Annotation<TeamStep[]>(),
  current: Annotation<number>(),
  results: Annotation<StepResult[]>(),
  /** Steps waiting for (another) attempt, in order. */
  queue: Annotation<number[]>(),
  round: Annotation<number>(),
  reply: Annotation<string>()
});
type TeamState = typeof State.State;

export async function runTeamTurn(deps: TeamDeps): Promise<{ reply: string; steps: TeamStep[]; results: StepResult[] }> {
  const maxSteps = deps.maxSteps ?? MAX_STEPS;
  const maxRetries = deps.maxRetries ?? MAX_RETRIES;
  const check = () => {
    if (deps.cancelled()) throw new Cancelled();
  };

  /** A plain call (no tools) whose whole reply is wanted, not streamed to the user. */
  async function ask(member: TeamMember, system: string, messages: BrainMessage[], showThinking = false): Promise<string> {
    let text = "";
    for await (const ev of member.provider.chat(messages, [], { system, effort: deps.effort })) {
      check();
      if (ev.type === "text-delta") text += ev.text;
      else if (ev.type === "reasoning-delta" && showThinking) deps.emit({ type: "thinking", text: ev.text });
      else if (ev.type === "error") throw new Error(ev.message);
    }
    return text;
  }

  /** Runs the agent loop for one role; streams its words to the user only when `toUser`. */
  async function work(member: TeamMember, kit: RoleKit, messages: BrainMessage[], step: number | null, toUser: boolean): Promise<string> {
    const loop = runAgentTurn(messages, { provider: member.provider, system: kit.system, tools: kit.tools, handlers: kit.handlers, effort: deps.effort });
    let finalText = "";
    let next: IteratorResult<AgentStreamEvent, BrainMessage[]>;
    while (!(next = await loop.next()).done) {
      check();
      const ev = next.value;
      if (ev.type === "text") {
        finalText += ev.text;
        if (toUser) deps.emit({ type: "text", text: ev.text });
      } else if (ev.type === "thinking") {
        if (toUser) deps.emit({ type: "thinking", text: ev.text });
      } else if (ev.type === "tool-start") {
        finalText = "";
        deps.emit({ type: "tool-start", name: ev.name, step });
      } else if (ev.type === "tool-end") deps.emit({ type: "tool-end", name: ev.name, isError: ev.isError, step });
      else if (ev.type === "tool-image") deps.emit({ type: "image", dataUrl: ev.dataUrl });
      else if (ev.type === "error") {
        if (toUser) deps.emit({ type: "error", message: ev.message });
        else finalText += `\n[error: ${ev.message}]`;
      }
    }
    return toUser ? finalText : summarizeWork(next.value, messages.length, finalText);
  }

  const stepPrompt = (s: TeamState, i: number, feedback: string | null) => {
    const step = s.steps[i]!;
    const earlier = s.results
      .map((r, j) => (j < i && r ? `Step ${j + 1} (${s.steps[j]!.goal}) produced:\n${r.output}` : ""))
      .filter(Boolean)
      .join("\n\n");
    return [
      `The user asked: ${deps.message.content}`,
      earlier ? `Work already done:\n${earlier}` : "",
      `Your step: ${step.goal}`,
      step.done ? `It's done when: ${step.done}` : "",
      feedback ? `A reviewer sent your last attempt back: ${feedback}` : "",
      "Do this step only, using the tools you have, then say in a sentence or two what you did and what you found."
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  async function runStep(s: TeamState, i: number, by: "executor" | "head"): Promise<string> {
    const member = by === "executor" ? deps.executor : deps.head;
    deps.emit({ type: "step", index: i, status: by === "head" ? "head" : "running", role: by, model: member.model });
    const step = s.steps[i]!;
    const kit = await deps.kitFor(by, step.modules, step.goal);
    const prior = s.results[i];
    return work(member, kit, [{ role: "user", content: stepPrompt(s, i, prior?.feedback ?? null) }], i, false);
  }

  const graph = new StateGraph(State)
    .addNode("route", async () => {
      check();
      // A plain message (nothing for any tool to do) goes straight to the Head: one call, as fast as
      // a single model.
      return { path: deps.needsTools ? ("plan" as const) : ("direct" as const) };
    })
    .addNode("direct", async () => {
      const kit = await deps.kitFor("head", null, deps.message.content);
      const reply = await work(deps.head, kit, [...deps.history, deps.message], null, true);
      return { reply };
    })
    .addNode("plan", async () => {
      const raw = await ask(deps.head, planSystem(deps.catalog, maxSteps), [...deps.history, deps.message], true);
      const steps = parsePlan(raw, new Set(deps.catalog.map((c) => c.id)), maxSteps);
      if (!steps.length) return { path: "direct" as const, steps: [] };
      deps.emit({ type: "plan", steps: steps.map((s) => ({ goal: s.goal })) });
      const results: StepResult[] = steps.map(() => ({ output: "", by: "executor", passed: null, feedback: null, attempts: 0 }));
      return { steps, results, queue: steps.map((_, i) => i), current: 0, round: 0 };
    })
    .addNode("execute", async (s) => {
      const [i, ...rest] = s.queue;
      if (i === undefined) return {};
      const takeover = s.results[i]!.attempts > maxRetries;
      const output = await runStep(s, i, takeover ? "head" : "executor");
      const results = [...s.results];
      results[i] = { ...results[i]!, output, by: takeover ? "head" : "executor", attempts: results[i]!.attempts + 1, passed: takeover ? true : null };
      if (takeover) deps.emit({ type: "step", index: i, status: "passed", role: "head", model: deps.head.model, note: "done by the Head" });
      return { results, queue: rest, current: i };
    })
    .addNode("checkOne", async (s) => {
      const i = s.current;
      const r = s.results[i]!;
      if (r.passed) return {};
      deps.emit({ type: "step", index: i, status: "checking", role: "checker", model: deps.checker.model });
      const verdict = parseVerdict(await ask(deps.checker, CHECK_ONE_SYSTEM, [{ role: "user", content: reviewPrompt(deps.message.content, [[i, s.steps[i]!, r]]) }]));
      return settle(s, [[i, verdict]]);
    })
    .addNode("checkAll", async (s) => {
      const pending = s.results.map((r, i) => [i, r] as const).filter(([, r]) => r.passed === null);
      if (!pending.length) return {};
      for (const [i] of pending) deps.emit({ type: "step", index: i, status: "checking", role: "checker", model: deps.checker.model });
      const raw = await ask(deps.checker, CHECK_ALL_SYSTEM, [{ role: "user", content: reviewPrompt(deps.message.content, pending.map(([i, r]) => [i, s.steps[i]!, r])) }]);
      const failed = parseFailures(raw);
      return { ...settle(s, pending.map(([i]) => [i, failed.has(i) ? { pass: false, feedback: failed.get(i)! } : { pass: true, feedback: null }])), round: s.round + 1 };
    })
    .addNode("answer", async (s) => {
      // Only the core prompt: the answer is written from the results, with no tools.
      const kit = await deps.kitFor("head", [], "");
      const work_ = s.steps.map((step, i) => `Step ${i + 1}: ${step.goal}\nResult${s.results[i]!.passed === false ? " (did NOT pass review)" : ""}:\n${s.results[i]!.output}`).join("\n\n");
      const system = `${kit.system}\n\n---\n\n${ANSWER_NOTE}`;
      const messages: BrainMessage[] = [...deps.history, deps.message, { role: "assistant", content: "I'll work on that." }, { role: "user", content: `[Results of the work on my request]\n\n${work_}\n\nNow write your reply to me.` }];
      const reply = await work(deps.head, { ...kit, system, tools: [], handlers: {} }, messages, null, true);
      return { reply };
    })
    .addEdge(START, "route")
    .addConditionalEdges("route", (s) => s.path)
    .addEdge("direct", END)
    .addConditionalEdges("plan", (s) => (s.path === "direct" ? "direct" : "execute"))
    .addConditionalEdges("execute", (s) => {
      if (deps.checkEachStep) return "checkOne";
      return s.queue.length ? "execute" : "checkAll";
    })
    .addConditionalEdges("checkOne", (s) => (s.queue.length ? "execute" : "answer"))
    .addConditionalEdges("checkAll", (s) => (s.queue.length ? "execute" : "answer"))
    .addEdge("answer", END)
    .compile();

  /** Records verdicts: a failed step goes back in the queue (with the feedback) until it has had its
   * retries; after that the Head does it. */
  function settle(s: TeamState, verdicts: Array<[number, { pass: boolean; feedback: string | null }]>): Partial<TeamState> {
    const results = [...s.results];
    const again: number[] = [];
    for (const [i, v] of verdicts) {
      const r = results[i]!;
      results[i] = { ...r, passed: v.pass ? true : null, feedback: v.pass ? null : v.feedback };
      const model = r.by === "head" ? deps.head.model : deps.executor.model;
      if (v.pass) deps.emit({ type: "step", index: i, status: "passed", role: r.by, model });
      else if (r.by === "executor") {
        // Sent back: the Executor tries again with the feedback; once its retries are used up the
        // step goes back in the queue for the Head (execute() sees the attempts and hands it over).
        const retry = r.attempts <= maxRetries;
        deps.emit({ type: "step", index: i, status: retry ? "retry" : "failed", role: r.by, model, note: retry ? v.feedback ?? undefined : "The Head takes this step over." });
        again.push(i);
      } else {
        results[i] = { ...results[i]!, passed: false };
        deps.emit({ type: "step", index: i, status: "failed", role: r.by, model, note: v.feedback ?? undefined });
      }
    }
    // In order, and ahead of steps not yet run, so later steps see the fixed result.
    const queue = [...new Set([...again, ...s.queue])].sort((a, b) => a - b);
    return { results, queue };
  }

  try {
    const out = await graph.invoke({ path: "direct", steps: [], current: 0, results: [], queue: [], round: 0, reply: "" }, { recursionLimit: 200 });
    return { reply: out.reply, steps: out.steps, results: out.results };
  } catch (err) {
    if (err instanceof Cancelled) return { reply: "", steps: [], results: [] };
    throw err;
  }
}

// ---- Prompts and parsing ----

export function planSystem(catalog: Array<{ id: string; summary: string }>, maxSteps: number): string {
  return [
    "You are the Head of a small team: you plan, an Executor with tools does the steps, and you write the final reply.",
    'If the user\'s latest message needs no tools (conversation, or a question you can answer yourself), reply with exactly: {"answer": true}',
    `Otherwise break it into at most ${maxSteps} short, concrete steps. Reply with only JSON, no other text:`,
    '{"steps": [{"goal": "what to do", "modules": ["id"], "done": "how to tell it worked"}]}',
    "Give each step only the modules it needs, from this list:",
    ...catalog.map((c) => `- ${c.id}: ${c.summary}`)
  ].join("\n");
}

const CHECK_ONE_SYSTEM = [
  "You review one step of work done for a user. Pass it when its result achieves the step's goal. Fail it when the result is missing,",
  "wrong, or claims something no tool output shows. Reply with only JSON:",
  '{"pass": true}  or  {"pass": false, "feedback": "what is wrong and what to do instead"}'
].join(" ");

const CHECK_ALL_SYSTEM = [
  "You review steps of work done for a user. A step passes when its result achieves its goal; it fails when the result is missing,",
  "wrong, or claims something no tool output shows. Reply with only JSON listing the failed steps by number (an empty list when all pass):",
  '{"failed": [{"step": 2, "feedback": "what is wrong and what to do instead"}]}'
].join(" ");

const ANSWER_NOTE =
  "You have the results of work done for the user's latest message. Write your reply from them. Don't mention steps, a team or tools " +
  "unless asked. If something didn't work, say so plainly instead of pretending it did.";

function reviewPrompt(request: string, items: Array<[number, TeamStep, StepResult]>): string {
  return [`The user asked: ${request}`, ...items.map(([i, step, r]) => `Step ${i + 1}: ${step.goal}\nDone when: ${step.done || "the goal is met"}\nResult:\n${r.output || "(nothing)"}`)].join("\n\n");
}

/** The first balanced {...} in a model's reply, parsed; null if there isn't one. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The Head's plan, cleaned: unknown modules dropped, at most `maxSteps`. [] means "just answer". */
export function parsePlan(raw: string, known: Set<string>, maxSteps = MAX_STEPS): TeamStep[] {
  const json = extractJson(raw) as { steps?: unknown } | null;
  if (!json || !Array.isArray(json.steps)) return [];
  return json.steps
    .map((s): TeamStep | null => {
      const step = s as Record<string, unknown>;
      const goal = typeof step.goal === "string" ? step.goal.trim() : "";
      if (!goal) return null;
      const modules = Array.isArray(step.modules) ? step.modules.filter((m): m is string => typeof m === "string" && known.has(m)) : [];
      return { goal: goal.slice(0, 500), modules: [...new Set(modules)], done: typeof step.done === "string" ? step.done.trim().slice(0, 300) : "" };
    })
    .filter((s): s is TeamStep => s !== null)
    .slice(0, maxSteps);
}

/** A reviewer that can't be understood doesn't block the work. */
export function parseVerdict(raw: string): { pass: boolean; feedback: string | null } {
  const json = extractJson(raw) as { pass?: unknown; feedback?: unknown } | null;
  if (!json || json.pass !== false) return { pass: true, feedback: null };
  return { pass: false, feedback: typeof json.feedback === "string" && json.feedback.trim() ? json.feedback.trim().slice(0, 600) : "The result doesn't achieve the goal." };
}

/** Failed steps from a review of several, by 0-based index. */
export function parseFailures(raw: string): Map<number, string> {
  const json = extractJson(raw) as { failed?: unknown } | null;
  const out = new Map<number, string>();
  if (!json || !Array.isArray(json.failed)) return out;
  for (const f of json.failed) {
    const item = f as Record<string, unknown>;
    const n = typeof item.step === "number" ? item.step : Number(item.step);
    if (Number.isInteger(n) && n >= 1) out.set(n - 1, typeof item.feedback === "string" && item.feedback.trim() ? item.feedback.trim().slice(0, 600) : "The result doesn't achieve the goal.");
  }
  return out;
}

/** A step's result for the Checker and the Head: what its tools returned and the model's last words. */
function summarizeWork(messages: BrainMessage[], from: number, finalText: string): string {
  const parts: string[] = [];
  const names = new Map<string, string>();
  for (const m of messages.slice(from)) {
    if (m.role === "assistant") for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
    if (m.role === "tool") {
      const body = m.content.length > TOOL_OUTPUT_CHARS ? `${m.content.slice(0, TOOL_OUTPUT_CHARS)}… (cut)` : m.content;
      parts.push(`[${names.get(m.toolCallId) ?? "tool"}${m.isError ? " failed" : ""}] ${body}`);
    }
  }
  if (finalText.trim()) parts.push(finalText.trim());
  return parts.join("\n") || "(the executor produced nothing)";
}
