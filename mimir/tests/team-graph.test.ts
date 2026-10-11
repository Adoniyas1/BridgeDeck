import { describe, expect, it } from "vitest";
import type { BrainMessage, BrainProvider, ChatEvent, ChatOpts, ToolDef } from "../src/main/brain/Provider.js";
import { extractJson, parseFailures, parsePlan, parseVerdict, runTeamTurn, type RoleKit, type TeamDeps, type TeamEvent } from "../src/main/team/graph.js";

type Reply = string | { tool: string; input?: Record<string, unknown> };

/** A stand-in model: answers each call with `respond(messages, system, tools)`. */
function fake(name: string, respond: (messages: BrainMessage[], opts: ChatOpts, tools: ToolDef[]) => Reply, calls: string[]): BrainProvider {
  return {
    kind: "openai-compatible",
    model: name,
    supportsTools: () => true,
    supportsVision: () => false,
    async *chat(messages: BrainMessage[], tools: ToolDef[], opts: ChatOpts): AsyncGenerator<ChatEvent, void, unknown> {
      calls.push(name);
      const r = respond(messages, opts, tools);
      if (typeof r === "string") {
        yield { type: "text-delta", text: r };
        yield { type: "done", stopReason: "end_turn" };
      } else {
        yield { type: "tool-call", call: { id: `c${calls.length}`, name: r.tool, input: r.input ?? {} } };
        yield { type: "done", stopReason: "tool_use" };
      }
    }
  } as unknown as BrainProvider;
}

const lastUser = (m: BrainMessage[]) => [...m].reverse().find((x) => x.role === "user")?.content ?? "";
const sawToolResult = (m: BrainMessage[]) => m.some((x) => x.role === "tool");

function deps(over: Partial<TeamDeps> & Pick<TeamDeps, "head" | "executor" | "checker">, events: TeamEvent[]): TeamDeps {
  const kit: RoleKit = {
    system: "core",
    tools: [{ name: "run_python", description: "run", inputSchema: { type: "object" } }],
    handlers: { run_python: async () => ({ content: "32.2" }) }
  };
  return {
    history: [],
    message: { role: "user", content: "what is 14% of 230?" },
    kitFor: async () => kit,
    catalog: [{ id: "compute", summary: "Run Python" }, { id: "memory", summary: "Remember facts" }],
    needsTools: true,
    checkEachStep: true,
    emit: (e) => events.push(e),
    cancelled: () => false,
    ...over
  };
}

const text = (events: TeamEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");

describe("team turn", () => {
  it("answers a plain message with the Head alone, in one call", async () => {
    const calls: string[] = [];
    const events: TeamEvent[] = [];
    const head = fake("qwen", () => "Hi! How can I help?", calls);
    const executor = fake("bonsai", () => "never", calls);
    const out = await runTeamTurn(deps({ head: { provider: head, model: "qwen" }, executor: { provider: executor, model: "bonsai" }, checker: { provider: head, model: "qwen" }, needsTools: false, message: { role: "user", content: "hi" } }, events));
    expect(out.reply).toBe("Hi! How can I help?");
    expect(calls).toEqual(["qwen"]);
    expect(text(events)).toBe("Hi! How can I help?");
  });

  it("plans, has the Executor do the step with tools, checks it and lets the Head write the reply", async () => {
    const calls: string[] = [];
    const events: TeamEvent[] = [];
    const head = fake("qwen", (m, opts) => {
      if (opts.system.includes("You are the Head")) return '{"steps":[{"goal":"Compute 14% of 230 with Python","modules":["compute","nope"],"done":"a number"}]}';
      if (opts.system.includes("You review")) return '{"pass": true}';
      return "14% of 230 is 32.2.";
    }, calls);
    const executor = fake("bonsai", (m) => (sawToolResult(m) ? "It is 32.2." : { tool: "run_python", input: { code: "print(230*0.14)" } }), calls);
    const out = await runTeamTurn(deps({ head: { provider: head, model: "qwen" }, executor: { provider: executor, model: "bonsai" }, checker: { provider: head, model: "qwen" } }, events));
    expect(out.reply).toBe("14% of 230 is 32.2.");
    expect(out.steps).toEqual([{ goal: "Compute 14% of 230 with Python", modules: ["compute"], done: "a number" }]);
    expect(out.results[0]).toMatchObject({ by: "executor", passed: true, attempts: 1 });
    expect(out.results[0]!.output).toContain("[run_python] 32.2");
    expect(calls).toEqual(["qwen", "bonsai", "bonsai", "qwen", "qwen"]);
    expect(events).toContainEqual({ type: "plan", steps: [{ goal: "Compute 14% of 230 with Python" }] });
    expect(events).toContainEqual({ type: "tool-start", name: "run_python", step: 0 });
    expect(events.filter((e) => e.type === "step").map((e) => (e as { status: string }).status)).toEqual(["running", "checking", "passed"]);
    // Only the reply reaches the user, not the plan or the Executor's words.
    expect(text(events)).toBe("14% of 230 is 32.2.");
  });

  it("sends a step back with the feedback, then hands it to the Head after the retries", async () => {
    const calls: string[] = [];
    const events: TeamEvent[] = [];
    const prompts: string[] = [];
    const head = fake("qwen", (m, opts) => {
      if (opts.system.includes("You are the Head")) return '{"steps":[{"goal":"Do it","modules":[],"done":"done"}]}';
      if (opts.system.includes("You review")) return '{"pass": false, "feedback": "wrong number"}';
      if (lastUser(m).startsWith("The user asked")) return "Head did it.";
      return "Final.";
    }, calls);
    const executor = fake("bonsai", (m) => { prompts.push(lastUser(m)); return "guess"; }, calls);
    const out = await runTeamTurn(deps({ head: { provider: head, model: "qwen" }, executor: { provider: executor, model: "bonsai" }, checker: { provider: head, model: "qwen" }, maxRetries: 2 }, events));
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("A reviewer sent your last attempt back: wrong number");
    expect(out.results[0]).toMatchObject({ by: "head", passed: true, output: "Head did it." });
    expect(out.reply).toBe("Final.");
    const statuses = events.filter((e) => e.type === "step").map((e) => (e as { status: string }).status);
    expect(statuses).toEqual(["running", "checking", "retry", "running", "checking", "retry", "running", "checking", "failed", "head", "passed"]);
  });

  it("checks all steps together at the end when told to, so models swap less", async () => {
    const calls: string[] = [];
    const events: TeamEvent[] = [];
    const head = fake("qwen", (m, opts) => {
      if (opts.system.includes("You are the Head")) return '{"steps":[{"goal":"A","modules":[],"done":""},{"goal":"B","modules":[],"done":""}]}';
      if (opts.system.includes("You review")) return calls.filter((c) => c === "qwen").length <= 2 ? '{"failed":[{"step":2,"feedback":"B is wrong"}]}' : '{"failed":[]}';
      return "Both done.";
    }, calls);
    const executor = fake("bonsai", (m) => `did ${lastUser(m).match(/Your step: (\w)/)?.[1]}`, calls);
    const out = await runTeamTurn(deps({ head: { provider: head, model: "qwen" }, executor: { provider: executor, model: "bonsai" }, checker: { provider: head, model: "qwen" }, checkEachStep: false }, events));
    // plan, A, B, review both, B again, review B, answer
    expect(calls).toEqual(["qwen", "bonsai", "bonsai", "qwen", "bonsai", "qwen", "qwen"]);
    expect(out.results.map((r) => r.passed)).toEqual([true, true]);
    expect(out.reply).toBe("Both done.");
  });

  it("answers directly when the Head's plan can't be read", async () => {
    const calls: string[] = [];
    const head = fake("qwen", (m, opts) => (opts.system.includes("You are the Head") ? "sure, I'll do it" : "Here you go."), calls);
    const out = await runTeamTurn(deps({ head: { provider: head, model: "qwen" }, executor: { provider: head, model: "qwen" }, checker: { provider: head, model: "qwen" } }, []));
    expect(out.reply).toBe("Here you go.");
    expect(out.steps).toEqual([]);
  });

  it("stops when cancelled", async () => {
    let stop = false;
    const head = fake("qwen", () => { stop = true; return '{"steps":[{"goal":"A","modules":[]}]}'; }, []);
    const out = await runTeamTurn(deps({ head: { provider: head, model: "qwen" }, executor: { provider: head, model: "qwen" }, checker: { provider: head, model: "qwen" }, cancelled: () => stop }, []));
    expect(out.reply).toBe("");
  });
});

describe("team parsing", () => {
  it("finds JSON inside chatty replies", () => {
    expect(extractJson('Sure! {"pass": true} hope that helps')).toEqual({ pass: true });
    expect(extractJson('{"a": "a } brace"}')).toEqual({ a: "a } brace" });
    expect(extractJson("no json")).toBeNull();
  });
  it("cleans a plan", () => {
    expect(parsePlan('{"answer": true}', new Set())).toEqual([]);
    expect(parsePlan('{"steps":[{"goal":" x ","modules":["compute","compute","bad"]},{"goal":""},{"goal":"y"}]}', new Set(["compute"]))).toEqual([
      { goal: "x", modules: ["compute"], done: "" },
      { goal: "y", modules: [], done: "" }
    ]);
    expect(parsePlan(JSON.stringify({ steps: Array.from({ length: 9 }, (_, i) => ({ goal: `s${i}` })) }), new Set(), 5)).toHaveLength(5);
  });
  it("reads verdicts, passing anything unreadable", () => {
    expect(parseVerdict('{"pass": false, "feedback": "no"}')).toEqual({ pass: false, feedback: "no" });
    expect(parseVerdict("looks fine to me")).toEqual({ pass: true, feedback: null });
    expect([...parseFailures('{"failed":[{"step":2,"feedback":"x"},{"step":"3"},{"step":0}]}').entries()]).toEqual([[1, "x"], [2, "The result doesn't achieve the goal."]]);
  });
});
