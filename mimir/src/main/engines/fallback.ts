import { engineName } from "./common.js";
import { contextHelp, NO_PROVIDER } from "./hermes.js";

/**
 * When an outside agent (Claude Code, OpenCode, Hermes) can't answer a message at all, Mimir
 * answers it with its own model instead of ending on an error, and says why in one line with
 * what to do about it. A message the user stopped is never answered again.
 */

export type Agent = "claude-code" | "opencode" | "hermes";
export type EngineProblem = { reason: string; fix: string };

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "";

/** What went wrong with an agent, from its error, in plain words, and what fixes it. */
export function engineProblem(engine: Agent, message: string): EngineProblem {
  const name = engineName(engine);
  const install = engine === "hermes" ? "Press Install Hermes in BridgeDeck's Settings → AI." : `Install ${name}, or set where it is in Settings → Brain team.`;
  if (/ENOENT|not found|no such file|command not found|is not recognized|spawn .* (EACCES|ENOENT)/i.test(message)) return { reason: `${name} isn't installed where Mimir looks`, fix: install };
  if (NO_PROVIDER.test(message) || /no (ai )?provider/i.test(message)) return { reason: `${name} has no AI provider set up`, fix: "Run `hermes model` in a terminal to pick one, or turn on “Use the Brain team's models” in Settings → Brain team." };
  if (contextHelp(message)) return { reason: "the model has too little context for Hermes (it needs 64K tokens)", fix: "Use an Ollama model, or raise the Head's context to 65536 in Settings → Model servers." };
  if (/\b(401|403)\b|unauthori[sz]ed|not (logged|signed) in|log ?in|sign ?in|api[ _-]?key|authenticat|invalid.*(key|token)/i.test(message)) {
    const how = engine === "claude-code" ? "Run `claude` in a terminal once and sign in." : engine === "opencode" ? "Run `opencode auth login` in a terminal." : "Run `hermes model` in a terminal and sign in to the provider.";
    return { reason: `${name} isn't signed in`, fix: `${how} Or turn on “Use the Brain team's models”.` };
  }
  if (/\b429\b|rate.?limit|quota|credit|billing|overloaded/i.test(message)) return { reason: `${name}'s provider refused (usage limit or no credit)`, fix: "Wait a while, check the account, or turn on “Use the Brain team's models” to use your own." };
  if (/timed? ?out|ETIMEDOUT|took too long/i.test(message)) return { reason: `${name} didn't answer in time`, fix: "Try again; if it keeps happening, use “Test my AI setup” in Settings → AI." };
  if (/ECONNREFUSED|fetch failed|network|ENOTFOUND|EAI_AGAIN/i.test(message)) return { reason: `${name} couldn't reach its model`, fix: "Check the internet connection, or that the model server is running (Settings → Model servers)." };
  const detail = firstLine(message.replace(/^[^:]*: /, ""));
  return { reason: `${name} stopped with an error${detail ? ` (${detail})` : ""}`, fix: "Use “Test my AI setup” in Settings → AI to see what's wrong, or Report a problem in Settings → About." };
}

/** The line shown above Mimir's own answer. */
export function fallbackNote(engine: Agent, message: string): string {
  const p = engineProblem(engine, message);
  return `_${engineName(engine)} couldn't answer: ${p.reason}, so Mimir answered with its own model. ${p.fix}_\n\n`;
}
