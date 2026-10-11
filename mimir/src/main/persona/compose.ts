import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dailyLogDir, personaFilePath } from "./paths.js";
import { DAILY_LOG_INJECT_DAYS, MEMORY_INJECT_MAX_CHARS } from "./templates.js";
import { loadPersonaConfig } from "./config.js";
import { loadPromptModules, type LoadedModule, type PromptLoadOptions, type SkippedModule } from "../prompts/loader.js";
import { CORE_MODULE_ID, getPromptModule, type PromptTier } from "../prompts/modules.js";

export interface PersonaPromptOptions {
  memoryMaxChars?: number;
  dailyLogDays?: number;
  /** Whether this session has any tools at all. False only for a genuinely
   * tool-less setup — just the core module (plus `localToolInstructions`),
   * with no capability modules. */
  includeToolInstructions?: boolean;
  /** Whether the user profile (USER.md) goes into the prompt. Small local
   * models skip it: it costs context and makes them talk about the user. */
  includeUserProfile?: boolean;
  /** A narrow, task-specific instruction for a tool-less small local model. */
  localToolInstructions?: string;
  /** Which tool set this turn has: "core" is the small curated set every
   * model gets, "full" adds everything else. */
  toolTier?: PromptTier;
  /** "all" (the default) describes every capability the tier allows;
   * "lazy" loads only the modules this turn needs — see prompts/loader.ts. */
  mode?: PromptLoadOptions["mode"];
  userText?: string;
  sticky?: PromptLoadOptions["sticky"];
  availableTools?: PromptLoadOptions["availableTools"];
  dynamicSkillTools?: PromptLoadOptions["dynamicSkillTools"];
  toolCost?: PromptLoadOptions["toolCost"];
  budgetTokens?: number;
  /** Module ids to leave out, e.g. "self_edit". */
  exclude?: readonly string[];
  /** Runtime modules, e.g. one per MCP server (see PromptLoadOptions.extraModules). */
  extraModules?: PromptLoadOptions["extraModules"];
  /** Module ids to load whatever the message says (see PromptLoadOptions.force). */
  force?: readonly string[];
}

export interface ComposedPrompt {
  system: string;
  /** Tools to offer this turn; null means no filtering. */
  toolNames: Set<string> | null;
  loaded: LoadedModule[];
  skipped: SkippedModule[];
  /** Estimated tokens in the loaded modules (prompt text and tool schemas). */
  moduleTokens: number;
}

/**
 * Builds the system prompt for a turn: the prompt modules the loader picked,
 * then context sections (what Mimir knows about the user, a size-capped tail
 * of long-term memory, deadlines, a few days of daily log). Deliberately does
 * NOT include the current time — see buildTurnContext() below for why that
 * lives elsewhere. This is the ONLY place persona files get read for
 * prompt-building — tools.ts writes them, this reads them.
 */
export async function composeSystemPrompt(workspaceRoot: string, options: PersonaPromptOptions = {}): Promise<ComposedPrompt> {
  const {
    memoryMaxChars = MEMORY_INJECT_MAX_CHARS,
    dailyLogDays = DAILY_LOG_INJECT_DAYS,
    includeToolInstructions = true,
    includeUserProfile = true,
    localToolInstructions = "",
    toolTier = "full",
    mode = "all"
  } = options;

  const [user, memoryTail, dailyLogTail, tasks] = await Promise.all([
    readPersonaFile(workspaceRoot, "USER.md"),
    readMemoryTail(workspaceRoot, memoryMaxChars),
    readRecentDailyLogs(workspaceRoot, dailyLogDays),
    readPersonaFile(workspaceRoot, "TASKS.md")
  ]);

  let sections: string[];
  let toolNames: Set<string> | null;
  let loaded: LoadedModule[];
  let skipped: SkippedModule[];
  let moduleTokens: number;
  if (includeToolInstructions) {
    const result = loadPromptModules({
      tier: toolTier,
      mode,
      userText: options.userText,
      sticky: options.sticky,
      availableTools: options.availableTools,
      dynamicSkillTools: options.dynamicSkillTools,
      toolCost: options.toolCost,
      budgetTokens: options.budgetTokens,
      exclude: options.exclude,
      force: options.force,
      extraModules: options.extraModules
    });
    ({ sections, toolNames, loaded, skipped } = result);
    moduleTokens = result.tokens;
  } else {
    const core = getPromptModule(CORE_MODULE_ID);
    sections = [core?.text ?? ""];
    if (localToolInstructions) sections.push(localToolInstructions);
    toolNames = new Set();
    loaded = core ? [{ id: core.id, title: core.title, tokens: 0, reason: "required" }] : [];
    skipped = [];
    moduleTokens = 0;
  }

  if (user.trim() && includeUserProfile) sections.push(`# What you know about the user (USER.md)\n\n${user.trim()}`);
  if (memoryTail.trim()) sections.push(`# Long-term memory (MEMORY.md)\n\n${memoryTail.trim()}`);
  if (tasks.trim()) sections.push(`# Upcoming deadlines and tasks (TASKS.md)\n\n${tasks.trim()}`);
  if (dailyLogTail.trim()) sections.push(`# Recent daily logs\n\n${dailyLogTail.trim()}`);

  return { system: sections.filter(Boolean).join("\n\n---\n\n"), toolNames, loaded, skipped, moduleTokens };
}

/** Just the system prompt text; see composeSystemPrompt(). */
export async function buildComposedSystemPrompt(workspaceRoot: string, options: PersonaPromptOptions = {}): Promise<string> {
  return (await composeSystemPrompt(workspaceRoot, options)).system;
}

/**
 * A short per-turn context line (current time, optional location) meant to
 * be prepended to the USER message, not baked into the system prompt.
 *
 * This used to live in the system prompt, which meant the one part of the
 * request that's supposed to be a large, stable, cheaply-reusable prefix
 * changed on literally every single turn (the timestamp is never identical
 * twice), defeating any prompt/KV caching a provider might do and adding
 * needless prefill latency on every request. Small local models on
 * constrained hardware feel this a lot more than a cloud model does. User
 * turns already change every time anyway, so that's where turn-varying
 * context belongs.
 */
export async function buildTurnContext(): Promise<string> {
  const config = await loadPersonaConfig();
  const parts = [`[${new Date().toString()}`];
  if (config.location) parts.push(`, ${config.location}`);
  return `${parts.join("")}]`;
}

export async function readPersonaFile(workspaceRoot: string, file: string): Promise<string> {
  const abs = personaFilePath(workspaceRoot, file);
  if (!existsSync(abs)) return "";
  try {
    return await readFile(abs, "utf-8");
  } catch {
    return "";
  }
}

async function readMemoryTail(workspaceRoot: string, maxChars: number): Promise<string> {
  const full = await readPersonaFile(workspaceRoot, "MEMORY.md");
  if (full.length <= maxChars) return full;
  return `[...truncated, showing the most recent ${maxChars} characters...]\n\n${full.slice(-maxChars)}`;
}

export async function readRecentDailyLogs(workspaceRoot: string, days = DAILY_LOG_INJECT_DAYS): Promise<string> {
  if (days <= 0) return "";
  const dir = dailyLogDir(workspaceRoot);
  if (!existsSync(dir)) return "";
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  const recent = entries.slice(-days);
  const parts: string[] = [];
  for (const file of recent) {
    try {
      const content = await readFile(`${dir}/${file}`, "utf-8");
      if (content.trim()) parts.push(`## ${file.replace(/\.md$/, "")}\n\n${content.trim()}`);
    } catch {
      // skip unreadable log file
    }
  }
  return parts.join("\n\n");
}
