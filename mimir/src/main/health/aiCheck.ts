import { existsSync } from "node:fs";
import type { BrainConfig, BrainRole, RoleStatus, SetupConfig, TeamConfig } from "../../shared/types.js";
import type { Upstream } from "../engines/anthropicBridge.js";
import { isLocalModel } from "../setup/plan.js";

/**
 * "Test my AI setup" (Settings → AI): every part Mimir's answers depend on, checked in order, each
 * with what's wrong in plain words and what to do. Nothing here changes anything.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface AiCheck {
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, when it isn't ok. */
  fix?: string;
}

type Fetch = typeof fetch;

/** Hermes refuses a model with less context than this (agent/model_metadata.py MINIMUM_CONTEXT_LENGTH). */
export const HERMES_REFUSES_BELOW = 64_000;
const GB = 1024 ** 3;
const ROLE_NAMES: Record<BrainRole, string> = { head: "Head", executor: "Executor", checker: "Checker" };

/** How much context a model is given, as its server reports it; null when it can't be told.
 * Ollama: what the model can take (Mimir asks it for 64K for Hermes). llama.cpp / llama-swap: the
 * -c the server was started with. */
export async function contextOf(model: Upstream, fetchImpl: Fetch = fetch): Promise<number | null> {
  const base = model.baseUrl.replace(/\/+$/, "");
  const timeout = () => AbortSignal.timeout(4000);
  try {
    if (model.ollama) {
      const res = await fetchImpl(`${base}/api/show`, { method: "POST", body: JSON.stringify({ model: model.model }), signal: timeout() });
      if (!res.ok) return null;
      const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
      const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
      return key && typeof info[key] === "number" ? (info[key] as number) : null;
    }
    // llama-swap passes /upstream/<model>/… to that model's llama-server; plain llama-server answers /props.
    for (const url of [`${base}/upstream/${encodeURIComponent(model.model)}/props`, `${base}/props`]) {
      const res = await fetchImpl(url, { signal: timeout() }).catch(() => null);
      if (!res?.ok) continue;
      const props = (await res.json()) as { n_ctx?: number; default_generation_settings?: { n_ctx?: number } };
      const n = props.default_generation_settings?.n_ctx ?? props.n_ctx;
      if (typeof n === "number" && n > 0) return n;
    }
  } catch {
    /* can't be told */
  }
  return null;
}

export interface CheckInput {
  team: TeamConfig;
  brain: BrainConfig;
  setup: SetupConfig;
  /** Each role's server, as teamStatus reports it (team mode). */
  roles: RoleStatus[];
  /** Whether the Brain's server answers and lists its model (one-model mode, not Claude). */
  brainServer: { reachable: boolean; models: string[]; detail: string } | null;
  /** The engine's command, when one is chosen: found or not. */
  engine: { ok: boolean; detail: string } | null;
  /** The model an agent gets on the team's models (for Hermes's context check), or why not. */
  agentModel: Upstream | Error | null;
  honchoKey: boolean;
  bridgedeck: { reachable: boolean; vault: boolean } | null;
  freeDiskBytes: number | null;
  fetchImpl?: Fetch;
  exists?: (path: string) => boolean;
}

const ENGINE_NAMES = { "claude-code": "Claude Code", opencode: "OpenCode", hermes: "Hermes" } as const;

export async function runAiChecks(input: CheckInput): Promise<AiCheck[]> {
  const { team, brain, setup } = input;
  const exists = input.exists ?? existsSync;
  const out: AiCheck[] = [];
  const agent = team.engine !== "mimir" ? ENGINE_NAMES[team.engine] : null;
  const usesOwnModels = !!agent && team.engineModels === "own";

  // What answers: the engine, and whose models.
  out.push({
    label: "Who answers",
    status: "ok",
    detail: agent
      ? `${agent}, on ${usesOwnModels ? "its own models and login" : team.mode === "single" ? `the Brain (${brain.model})` : "the Brain team's models"}`
      : team.mode === "single" ? `Mimir, on one model: ${brain.model} (${brain.provider === "anthropic" ? "Claude" : brain.provider === "ollama" ? "Ollama" : "a server"})` : "Mimir, with the Brain team (Head, Executor, Checker)"
  });

  // The models' servers.
  if (!usesOwnModels) {
    if (team.mode === "single") {
      if (brain.provider === "anthropic") {
        out.push(brain.hasApiKey
          ? { label: "Claude", status: "ok", detail: "API key saved" }
          : { label: "Claude", status: "fail", detail: "No Anthropic API key saved", fix: "Add it in Mimir's Settings → Brain, or set the Brain to Ollama." });
      } else if (input.brainServer) {
        const s = input.brainServer;
        const where = brain.provider === "ollama" ? "Ollama" : "The Brain's server";
        if (!s.reachable) out.push({ label: where, status: "fail", detail: s.detail, fix: brain.provider === "ollama" ? "Start Ollama (open the Ollama app, or run `ollama serve`)." : "Start that server, or check its address in Mimir's Settings → Brain." });
        else if (s.models.length && !s.models.includes(brain.model)) out.push({ label: where, status: "fail", detail: `It's up but doesn't have ${brain.model} (it has ${s.models.slice(0, 5).join(", ")}${s.models.length > 5 ? ", …" : ""}).`, fix: brain.provider === "ollama" ? `Run \`ollama pull ${brain.model}\`, or pick one of those in the top bar.` : "Pick one of those models in the top bar." });
        else out.push({ label: where, status: "ok", detail: `${s.detail}, with ${brain.model}` });
      }
    } else {
      for (const r of input.roles) {
        if (r.role === "checker" && team.checkerSameAsHead) continue;
        out.push(r.reachable
          ? { label: `${ROLE_NAMES[r.role]} model`, status: r.using === "fallback" ? "warn" : "ok", detail: r.detail }
          : { label: `${ROLE_NAMES[r.role]} model`, status: "fail", detail: r.detail, fix: "Start the model servers (Mimir's Settings → Model servers → Start), or turn the PC on if the role uses it." });
      }
    }
  }

  // The models this computer loads from files.
  for (const role of ["head", "executor", "checker"] as const) {
    const m = setup.models[role];
    if (m && isLocalModel(m.source) && !exists(m.source.replace(/^~(?=\/)/, process.env.HOME ?? "~"))) {
      out.push({ label: `${ROLE_NAMES[role]}'s model file`, status: "fail", detail: `${m.source} isn't there`, fix: "Download a model in Settings → AI → AI models and use it for this role, or pick the file again in Model servers." });
    }
  }

  // The agent itself.
  if (agent && input.engine) {
    out.push(input.engine.ok
      ? { label: agent, status: "ok", detail: input.engine.detail }
      : { label: agent, status: "fail", detail: input.engine.detail, fix: team.engine === "hermes" ? "Press Install Hermes in Settings → AI." : `Install ${agent}, or set its path in Mimir's Settings → Brain team.` });
  }

  // Hermes needs a model with at least 64K tokens of context.
  if (team.engine === "hermes") {
    if (usesOwnModels) {
      out.push({ label: "Hermes's provider", status: "warn", detail: "Hermes uses its own provider; Mimir can't see which.", fix: "If it says it isn't connected to any AI provider, run `hermes model` in a terminal, or turn on “Use the Brain team's models”." });
    } else if (input.agentModel instanceof Error) {
      out.push({ label: "Model for Hermes", status: "fail", detail: input.agentModel.message });
    } else if (input.agentModel) {
      const ctx = await contextOf(input.agentModel, input.fetchImpl);
      const name = input.agentModel.model;
      if (input.agentModel.ollama) {
        out.push(ctx === null
          ? { label: "Context for Hermes", status: "warn", detail: `Couldn't read how much context ${name} can take.` }
          : ctx >= HERMES_REFUSES_BELOW
            ? { label: "Context for Hermes", status: "ok", detail: `${name} takes ${Math.round(ctx / 1024)}K tokens; Mimir asks Ollama for 64K.${setup.computer === "mac" ? " On an 8 GB Mac that can be more memory than there is." : ""}` }
            : { label: "Context for Hermes", status: "fail", detail: `${name} takes only ${Math.round(ctx / 1024)}K tokens; Hermes needs 64K.`, fix: "Pick a model made for long context (Qwen3.5, Llama 3.2 and most new models take 128K)." });
      } else {
        out.push(ctx === null
          ? { label: "Context for Hermes", status: "warn", detail: `Couldn't read the context ${name} runs with (it may not be loaded yet).`, fix: "Hermes needs 64K: check the Head's -c in Model servers." }
          : ctx >= HERMES_REFUSES_BELOW
            ? { label: "Context for Hermes", status: "ok", detail: `${name} runs with ${Math.round(ctx / 1024)}K tokens` }
            : { label: "Context for Hermes", status: "fail", detail: `${name} runs with ${Math.round(ctx / 1024)}K tokens; Hermes needs 64K and will refuse it.`, fix: "Use Ollama for Hermes, or raise the Head's -c to 65536 in Model servers (the PC's card can take it; the 8 GB Mac can't)." });
      }
    }
    if (team.honcho.enabled && !input.honchoKey && !team.honcho.baseUrl) {
      out.push({ label: "Honcho", status: "fail", detail: "Honcho is on but has no API key or server.", fix: "Add the key in Settings → AI, or turn Honcho off." });
    }
  }

  // BridgeDeck: Mimir's tools and the notes vault.
  if (input.bridgedeck) {
    out.push(input.bridgedeck.reachable
      ? { label: "BridgeDeck", status: input.bridgedeck.vault ? "ok" : "warn", detail: input.bridgedeck.vault ? "Mimir can use your notes, calendar and courses; its memory is in your notes vault." : "Mimir can use your notes, calendar and courses. The notes vault is off, so Obsidian doesn't see Mimir's memory.", fix: input.bridgedeck.vault ? undefined : "Turn on the vault in Settings → Notes if you want it in Obsidian." }
      : { label: "BridgeDeck", status: "fail", detail: "Mimir can't reach BridgeDeck's tools.", fix: "Restart Mimir (Settings → AI → Stop, then Open Jarvis)." });
  }

  if (input.freeDiskBytes !== null && input.freeDiskBytes < 5 * GB) {
    out.push({ label: "Disk space", status: input.freeDiskBytes < 2 * GB ? "fail" : "warn", detail: `${(input.freeDiskBytes / GB).toFixed(1)} GB free`, fix: "Free some space: models and their downloads need several GB." });
  }
  return out;
}

