import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MIMIR_HOME } from "../config/store.js";
import { AcpAgent } from "./acp.js";
import type { EngineResult, EngineTurn } from "./common.js";
import type { Upstream } from "./anthropicBridge.js";

/**
 * Hermes Agent (Nous Research) as Mimir's agent, over ACP (`hermes acp`; engines/acp.ts).
 *
 * With the team's models, Hermes runs in its own profile, `~/.mimir/hermes` (HERMES_HOME), whose
 * config.yaml Mimir writes each time: the Head's server as a custom OpenAI-compatible endpoint,
 * and Honcho as its memory when chosen. Its own MEMORY.md, USER.md and skills stay in that profile
 * between chats. With its own models, Hermes uses the user's normal profile (~/.hermes) untouched.
 */

/** Honcho, Hermes's memory plugin (honcho.dev): the user's API key, or a self-hosted server. */
export interface HonchoSettings {
  apiKey: string | null;
  baseUrl: string | null;
  /** Who the user is to Honcho (a peer name). */
  peerName: string;
}

export const hermesHome = () => path.join(MIMIR_HOME, "hermes");

/** Hermes refuses models with less context than this (agent/model_metadata.py MINIMUM_CONTEXT_LENGTH). */
export const HERMES_MIN_CONTEXT = 65536;

/** Hermes turned the model down for too little context: what to do about it. */
export function contextHelp(message: string): string | null {
  if (!/context/i.test(message) || !/(minimum|too small|at least|64[,_]?0{3}|65[,_]?536|below)/i.test(message)) return null;
  return `${message}\n\nHermes needs a model with at least 64K tokens of context. Mimir's own model servers start with less (8K on the Mac, 16K on the PC) to save memory. Use an Ollama model (Mimir asks it for 64K), raise the Head's -c to 65536 in Settings → Model servers, or give Hermes its own provider with \`hermes model\`.`;
}

/** JSON strings are valid YAML scalars, so values are written that way (no quoting surprises). */
const y = (v: string) => JSON.stringify(v);

/** The profile's config.yaml for the team's model (and Honcho when chosen). */
export function hermesConfig(model: Upstream, honcho: HonchoSettings | null): string {
  const lines = [
    "# Written by Mimir before each Hermes chat (Settings → Brain team). Changes here are replaced.",
    "model:",
    "  provider: custom",
    `  default: ${y(model.model)}`,
    `  base_url: ${y(`${model.baseUrl.replace(/\/+$/, "")}/v1`)}`,
    `  api_key: ${y(model.apiKey || "none")}`,
    // Hermes won't run below 64K tokens; Ollama sizes the context per request, so ask for exactly that
    // (more would only fill memory). Other servers have theirs fixed when they start.
    ...(model.ollama ? [`  context_length: ${HERMES_MIN_CONTEXT}`] : []),
    "approvals:",
    // Approval cards wait for the user in Mimir's window.
    "  timeout: 600",
  ];
  if (honcho) lines.push("memory:", "  provider: honcho");
  return `${lines.join("\n")}\n`;
}

/** Honcho's settings file in the profile (the plugin reads $HERMES_HOME/honcho.json first). */
export function honchoConfig(h: HonchoSettings): string {
  return `${JSON.stringify({
    ...(h.apiKey ? { apiKey: h.apiKey } : {}),
    ...(h.baseUrl ? { baseUrl: h.baseUrl } : {}),
    peerName: h.peerName,
    aiPeer: "mimir",
    workspace: "mimir",
    recallMode: "hybrid",
    // A dialectic (Honcho's own LLM call) every few turns, not every turn: keeps the cost down.
    dialecticCadence: 3,
    sessionStrategy: "global"
  }, null, 2)}\n`;
}

export interface HermesOptions {
  command: string;
  /** The team's model, or null for Hermes's own setup. */
  model: Upstream | null;
  honcho: HonchoSettings | null;
  /** What Mimir knows about the user, given to each new conversation. */
  intro?: string;
  mcpServers?: Array<Record<string, unknown>>;
  /** For tests: where the profile goes. */
  home?: string;
}

export class HermesAgent {
  private acp = new AcpAgent("hermes");

  async run(turn: EngineTurn, options: HermesOptions): Promise<EngineResult> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    let setup = "own";
    if (options.model) {
      const home = options.home ?? hermesHome();
      await mkdir(home, { recursive: true });
      const config = hermesConfig(options.model, options.honcho);
      await writeFile(path.join(home, "config.yaml"), config);
      if (options.honcho) await writeFile(path.join(home, "honcho.json"), honchoConfig(options.honcho), { mode: 0o600 });
      env.HERMES_HOME = home;
      setup = config + (options.honcho ? honchoConfig(options.honcho) : "");
    }
    const key = JSON.stringify([options.command, setup, options.mcpServers ?? []]);
    return this.acp.run(turn, { command: options.command, args: ["acp"], env, intro: options.intro, mcpServers: options.mcpServers }, key);
  }

  stop(): void {
    this.acp.stop();
  }
}

/** What Hermes answers when it has no AI provider of its own (hermes_cli/auth.py resolve_provider). */
export const NO_PROVIDER = /not connected to any AI provider/i;

/** Said when Hermes has no provider and Mimir can't lend it the team's model. */
export const NO_PROVIDER_HELP =
  "Hermes has no AI provider of its own yet. Turn on “Use the Brain team's models” (Mimir's Settings → Brain team, or BridgeDeck's Settings → Mimir), or run `hermes model` in a terminal to give Hermes one.";

/** Said above a reply that used the team's model because Hermes has none of its own. */
export const BORROWED_NOTE =
  "(Hermes has no AI provider of its own yet, so this answer used your Brain team's model. Run `hermes model` in a terminal to give it one, or turn on “Use the Brain team's models” to make this the plan.)\n\n";

/**
 * Holds back the start of a reply, so Hermes's "not connected to any AI provider" answer can be
 * caught before it shows in the chat. Anything else is passed on once it's clearly not that answer
 * (enough text, or a tool step).
 */
export function holdBack(turn: EngineTurn, enough = 160) {
  let held = "";
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (held) turn.emit({ type: "text", text: held });
  };
  const emit: EngineTurn["emit"] = (event) => {
    if (released) return turn.emit(event);
    if (event.type !== "text") {
      release();
      return turn.emit(event);
    }
    held += event.text;
    if (held.length >= enough && !NO_PROVIDER.test(held)) release();
  };
  return {
    turn: { ...turn, emit },
    /** Whether the reply so far is Hermes's "no provider" answer (nothing of it was shown). */
    noProvider: () => !released && NO_PROVIDER.test(held),
    release
  };
}
