import { PROMPT_MODULES, type PromptModule, type PromptTier } from "./modules.js";

/** Rough token count for budgeting; this only has to rank things, not bill them. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

/** Optional modules (prompt text plus tool schemas) a local model may load per turn, on top of the required ones. */
export const DEFAULT_LAZY_BUDGET_TOKENS = 1800;
/** A module that matched stays loaded for this many follow-up turns, so "now save it" still has its tools. */
export const STICKY_TURNS = 2;

export type LoadReason = "required" | "matched" | "sticky" | "all";
export type SkipReason = "no match" | "tier" | "unavailable" | "excluded" | "over budget";

export interface LoadedModule {
  id: string;
  title: string;
  tokens: number;
  reason: LoadReason;
}

export interface SkippedModule {
  id: string;
  title: string;
  reason: SkipReason;
}

export interface PromptLoadOptions {
  tier: PromptTier;
  /**
   * "lazy" sends the required modules plus whatever this turn needs, one at a time, until the budget is used.
   * "all" sends every module the tier allows (cloud models, where context is cheap).
   */
  mode: "lazy" | "all";
  userText?: string;
  /** Module id -> follow-up turns it stays loaded for. */
  sticky?: ReadonlyMap<string, number>;
  /** Tools that actually exist this turn. When omitted nothing is filtered by availability. */
  availableTools?: ReadonlySet<string>;
  /** Names of the user's own skill_<name> tools. */
  dynamicSkillTools?: readonly string[];
  /** Token cost of one tool's schema; used for the budget. */
  toolCost?: (name: string) => number;
  budgetTokens?: number;
  exclude?: readonly string[];
}

export interface PromptLoad {
  /** Module texts, in registry order. */
  sections: string[];
  /** The tools to offer; null means "do not filter" (all mode on the full tier). */
  toolNames: Set<string> | null;
  loaded: LoadedModule[];
  skipped: SkippedModule[];
  /** Estimated tokens for everything loaded (text and tool schemas). */
  tokens: number;
}

function textFor(module: PromptModule, tier: PromptTier): string {
  return tier === "core" && module.coreText !== undefined ? module.coreText : module.text;
}

function toolsFor(module: PromptModule, tier: PromptTier): string[] {
  return tier === "core" ? module.coreTools : module.tools;
}

function matches(module: PromptModule, userText: string): boolean {
  if (module.triggers.some((trigger) => trigger.test(userText))) return true;
  // Naming a tool outright always loads the module that owns it.
  return module.tools.some((tool) => userText.includes(tool));
}

/**
 * Picks the prompt modules for one turn. Required modules always load. Optional ones are considered one by one
 * in registry order and loaded when the message matches (or they were loaded a moment ago) and they still fit
 * the budget, so the cheap, high-value modules are never crowded out by an expensive one.
 */
export function loadPromptModules(opts: PromptLoadOptions): PromptLoad {
  const { tier, mode, availableTools } = opts;
  const userText = opts.userText ?? "";
  const budget = opts.budgetTokens ?? DEFAULT_LAZY_BUDGET_TOKENS;
  const excluded = new Set(opts.exclude ?? []);
  const toolCost = opts.toolCost ?? (() => 0);

  const loaded: LoadedModule[] = [];
  const skipped: SkippedModule[] = [];
  const sections: string[] = [];
  const toolNames = new Set<string>();
  let used = 0;
  let optionalUsed = 0;

  for (const module of PROMPT_MODULES) {
    const info = { id: module.id, title: module.title };
    if (excluded.has(module.id)) { skipped.push({ ...info, reason: "excluded" }); continue; }
    if (!module.tiers.includes(tier)) { skipped.push({ ...info, reason: "tier" }); continue; }

    const wanted = toolsFor(module, tier);
    const offered = availableTools ? wanted.filter((tool) => availableTools.has(tool)) : wanted;
    // A tools-only group (BridgeDeck's, say) that has nothing to offer right now is not "loaded".
    if (!module.required && wanted.length > 0 && offered.length === 0) { skipped.push({ ...info, reason: "unavailable" }); continue; }

    let reason: LoadReason | null = null;
    if (module.required) reason = "required";
    else if (mode === "all") reason = "all";
    else if (matches(module, userText)) reason = "matched";
    else if ((opts.sticky?.get(module.id) ?? 0) > 0) reason = "sticky";
    if (!reason) { skipped.push({ ...info, reason: "no match" }); continue; }

    const text = textFor(module, tier);
    const cost = estimateTokens(text) + offered.reduce((sum, tool) => sum + toolCost(tool), 0);
    if (reason !== "required" && mode === "lazy" && optionalUsed + cost > budget) {
      skipped.push({ ...info, reason: "over budget" });
      continue;
    }

    if (text) sections.push(text);
    for (const tool of offered) toolNames.add(tool);
    loaded.push({ ...info, tokens: cost, reason });
    used += cost;
    if (reason !== "required") optionalUsed += cost;
  }

  // The user's own skill_<name> tools: with the Skills module, or when the message names one.
  const skillsLoaded = loaded.some((m) => m.id === "skills");
  const lowered = userText.toLowerCase();
  for (const name of opts.dynamicSkillTools ?? []) {
    const bare = name.replace(/^skill_/, "").toLowerCase();
    const named = lowered.includes(bare) || lowered.includes(bare.replace(/[_-]+/g, " "));
    if (mode === "all" || skillsLoaded || named) {
      if (named && !skillsLoaded && mode === "lazy" && optionalUsed + toolCost(name) > budget) continue;
      toolNames.add(name);
      used += toolCost(name);
    }
  }

  return {
    sections,
    toolNames: mode === "all" && tier === "full" ? null : toolNames,
    loaded,
    skipped,
    tokens: used
  };
}
