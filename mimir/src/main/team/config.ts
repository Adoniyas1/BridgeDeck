import type { BrainRole, RoleConfig, RoleEndpoint, TeamConfig, TeamPreset, ToolTierChoice } from "../../shared/types.js";
import { readJsonFile, writeJsonFile } from "../config/store.js";

/**
 * The Brain team: which model plans (Head), which reviews (Checker) and which makes the tool calls
 * (Executor), each with a primary server and a fallback. Kept per computer in ~/.mimir/team.json,
 * so the Mac and the Windows PC can each use what they can run.
 */
const FILE = "team.json";

export const ROLES: BrainRole[] = ["head", "checker", "executor"];

/** llama-swap's default address: one server in front of the Mac's or the PC's llama.cpp models. */
export const LOCAL_SWAP_URL = "http://127.0.0.1:8080";

const endpoint = (model: string, baseUrl: string = LOCAL_SWAP_URL): RoleEndpoint => ({ provider: "openai-compatible", model, baseUrl });
const role = (primary: RoleEndpoint, fallback: RoleEndpoint | null = null, tier: ToolTierChoice = "auto"): RoleConfig => ({ primary, fallback, tier });

/** Model names as the setup helpers (phase 6) register them in llama-swap. */
export const MODELS = {
  macHead: "qwen3.5-9b",
  macExecutor: "bonsai-8b",
  pcHead: "bonsai-2-27b",
  pcExecutor: "bonsai-8b",
  pcChecker: "qwen3.5-9b"
} as const;

export const DEFAULT_TEAM: TeamConfig = {
  mode: "single",
  engine: "mimir",
  engineModels: "team",
  engineFallback: true,
  thinking: false,
  engineCommands: { "claude-code": null, opencode: null, hermes: null },
  roles: {
    head: role(endpoint(MODELS.macHead)),
    checker: role(endpoint(MODELS.macHead)),
    executor: role(endpoint(MODELS.macExecutor), null, "core")
  },
  checkerSameAsHead: true,
  checkEachStep: false,
  preset: null,
  vision: null,
  honcho: { enabled: false, baseUrl: null, peerName: "me", keySaved: false }
};

export const TEAM_PRESETS: TeamPreset[] = [
  {
    id: "mac-mlx",
    title: "This Mac",
    description: "Qwen3.5-9B (IQ3_XXS) plans and checks, Ternary Bonsai 8B makes the tool calls, both on this Mac through llama-swap and llama.cpp. They take turns in memory, so steps are checked together at the end.",
    needsPcAddress: false
  },
  {
    id: "windows-llamacpp",
    title: "This Windows PC (llama.cpp)",
    description: "Ternary Bonsai 2 27B plans and writes, Ternary Bonsai 8B makes the tool calls, Qwen3.5-9B (IQ3_XXS) checks each step, all through llama-swap and PrismML's llama.cpp on the GPU. They take turns, so steps are checked together at the end.",
    needsPcAddress: false
  },
  {
    id: "mac-with-pc",
    title: "This Mac, using the PC when it's on",
    description: "Every role runs on the Windows PC's models when the PC answers, and on this Mac's own models when it doesn't.",
    needsPcAddress: true
  }
];

/** "192.168.1.20", "192.168.1.20:8080" or "http://pc:8080" → "http://192.168.1.20:8080". */
export function pcBaseUrl(address: string): string {
  const trimmed = address.trim().replace(/\/+$/, "");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return /:\d+$/.test(withScheme.replace(/^[a-z]+:\/\//i, "")) ? withScheme : `${withScheme}:8080`;
}

/** `localUrl`: this computer's llama-swap, when it isn't on the default port. */
export function presetConfig(id: string, current: TeamConfig, pcAddress?: string, localUrl: string = LOCAL_SWAP_URL): TeamConfig {
  const base = { ...current, mode: "team" as const, preset: id, checkerSameAsHead: true };
  const endpoint = (model: string, baseUrl: string = localUrl): RoleEndpoint => ({ provider: "openai-compatible", model, baseUrl });
  switch (id) {
    case "mac-mlx":
      return { ...base, checkEachStep: false, roles: { head: role(endpoint(MODELS.macHead)), checker: role(endpoint(MODELS.macHead)), executor: role(endpoint(MODELS.macExecutor), null, "core") } };
    case "windows-llamacpp":
      return { ...base, checkerSameAsHead: false, checkEachStep: false, roles: { head: role(endpoint(MODELS.pcHead)), checker: role(endpoint(MODELS.pcChecker)), executor: role(endpoint(MODELS.pcExecutor)) } };
    case "mac-with-pc": {
      if (!pcAddress?.trim()) throw new Error("Enter the PC's address (for example 192.168.1.20:8080).");
      const pc = pcBaseUrl(pcAddress);
      return {
        ...base,
        checkerSameAsHead: false,
        checkEachStep: false,
        roles: {
          head: role(endpoint(MODELS.pcHead, pc), endpoint(MODELS.macHead)),
          checker: role(endpoint(MODELS.pcChecker, pc), endpoint(MODELS.macHead)),
          executor: role(endpoint(MODELS.pcExecutor, pc), endpoint(MODELS.macExecutor), "core")
        }
      };
    }
    default:
      throw new Error(`No preset called ${id}`);
  }
}

const PROVIDERS = new Set(["anthropic", "ollama", "openai-compatible"]);
const ENGINES = new Set(["mimir", "claude-code", "opencode", "hermes"]);
const TIERS = new Set(["auto", "core", "full"]);

const cleanCommand = (raw: unknown): string | null => (typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 500) : null);

function cleanEndpoint(raw: unknown, fallback: RoleEndpoint): RoleEndpoint {
  const e = (raw ?? {}) as Partial<RoleEndpoint>;
  return {
    provider: PROVIDERS.has(String(e.provider)) ? (e.provider as RoleEndpoint["provider"]) : fallback.provider,
    model: typeof e.model === "string" && e.model.trim() ? e.model.trim().slice(0, 200) : fallback.model,
    baseUrl: typeof e.baseUrl === "string" && e.baseUrl.trim() ? e.baseUrl.trim().slice(0, 300) : e.baseUrl === null ? null : fallback.baseUrl
  };
}

function cleanRole(raw: unknown, fallback: RoleConfig): RoleConfig {
  const r = (raw ?? {}) as Partial<RoleConfig>;
  return {
    primary: cleanEndpoint(r.primary, fallback.primary),
    fallback: r.fallback === null || r.fallback === undefined ? (r.fallback === undefined ? fallback.fallback : null) : cleanEndpoint(r.fallback, fallback.fallback ?? fallback.primary),
    tier: TIERS.has(String(r.tier)) ? (r.tier as ToolTierChoice) : fallback.tier
  };
}

function cleanHoncho(raw: unknown, fallback: TeamConfig["honcho"]): TeamConfig["honcho"] {
  const h = (raw ?? {}) as Partial<TeamConfig["honcho"]>;
  const url = typeof h.baseUrl === "string" && /^https?:\/\//.test(h.baseUrl.trim()) ? h.baseUrl.trim().slice(0, 300) : h.baseUrl === null ? null : fallback.baseUrl;
  const peer = typeof h.peerName === "string" && /^[\w.-]{1,40}$/.test(h.peerName.trim()) ? h.peerName.trim() : fallback.peerName;
  return {
    enabled: typeof h.enabled === "boolean" ? h.enabled : fallback.enabled,
    baseUrl: url,
    peerName: peer,
    keySaved: typeof h.keySaved === "boolean" ? h.keySaved : fallback.keySaved
  };
}

/** A whole, valid config from whatever was stored or sent, filling gaps from `base`. */
export function cleanTeamConfig(raw: unknown, base: TeamConfig = DEFAULT_TEAM): TeamConfig {
  const c = (raw ?? {}) as Partial<TeamConfig>;
  const roles = (c.roles ?? {}) as Partial<Record<BrainRole, unknown>>;
  return {
    mode: c.mode === "team" ? "team" : c.mode === "single" ? "single" : base.mode,
    engine: ENGINES.has(String(c.engine)) ? (c.engine as TeamConfig["engine"]) : base.engine,
    engineModels: c.engineModels === "own" ? "own" : c.engineModels === "team" ? "team" : base.engineModels,
    engineFallback: typeof c.engineFallback === "boolean" ? c.engineFallback : base.engineFallback,
    thinking: typeof c.thinking === "boolean" ? c.thinking : base.thinking,
    engineCommands: {
      "claude-code": c.engineCommands && "claude-code" in c.engineCommands ? cleanCommand(c.engineCommands["claude-code"]) : base.engineCommands["claude-code"],
      opencode: c.engineCommands && "opencode" in c.engineCommands ? cleanCommand(c.engineCommands.opencode) : base.engineCommands.opencode,
      hermes: c.engineCommands && "hermes" in c.engineCommands ? cleanCommand(c.engineCommands.hermes) : base.engineCommands.hermes
    },
    roles: {
      head: cleanRole(roles.head, base.roles.head),
      checker: cleanRole(roles.checker, base.roles.checker),
      executor: cleanRole(roles.executor, base.roles.executor)
    },
    checkerSameAsHead: typeof c.checkerSameAsHead === "boolean" ? c.checkerSameAsHead : base.checkerSameAsHead,
    checkEachStep: typeof c.checkEachStep === "boolean" ? c.checkEachStep : base.checkEachStep,
    preset: typeof c.preset === "string" ? c.preset : c.preset === null ? null : base.preset,
    vision: c.vision === null ? null : c.vision ? cleanEndpoint(c.vision, base.vision ?? endpoint(MODELS.pcChecker)) : base.vision,
    honcho: cleanHoncho(c.honcho, base.honcho)
  };
}

export async function loadTeamConfig(): Promise<TeamConfig> {
  return cleanTeamConfig(await readJsonFile<unknown>(FILE, DEFAULT_TEAM));
}

/** Merges a change into the saved config. Editing a role by hand detaches it from its preset. */
export async function saveTeamConfig(patch: Partial<TeamConfig>): Promise<TeamConfig> {
  const current = await loadTeamConfig();
  const next = cleanTeamConfig({ ...current, ...patch, roles: { ...current.roles, ...(patch.roles ?? {}) }, preset: patch.roles ? null : patch.preset ?? current.preset }, current);
  await writeJsonFile(FILE, next);
  return next;
}

export async function applyTeamPreset(id: string, pcAddress?: string, localUrl?: string): Promise<TeamConfig> {
  const next = presetConfig(id, await loadTeamConfig(), pcAddress, localUrl);
  await writeJsonFile(FILE, next);
  return next;
}

/** The settings a role actually uses: the Checker borrows the Head's when told to. */
export function roleSettings(config: TeamConfig, which: BrainRole): RoleConfig {
  return which === "checker" && config.checkerSameAsHead ? config.roles.head : config.roles[which];
}
