import type { BrainProvider } from "../brain/Provider.js";
import { createProviderFor } from "../brain/index.js";
import { getBrainApiKey } from "../brain/config.js";
import { normalizeBaseUrl } from "../brain/baseUrl.js";
import type { BrainRole, RoleEndpoint, RoleStatus, TeamConfig } from "../../shared/types.js";
import { roleSettings } from "./config.js";

export interface ProbeResult {
  reachable: boolean;
  models: string[];
  detail: string;
}

type Fetch = typeof fetch;

/** How long an answer (or a failure) from a server is trusted before asking again. */
const PROBE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; result: ProbeResult }>();

export function clearProbeCache(): void {
  cache.clear();
}

/** Whether a server answers, and the models it offers. Never throws: an unreachable server is a
 * normal state (the PC is off), not an error. */
export async function probeEndpoint(endpoint: RoleEndpoint, fetchImpl: Fetch = fetch, timeoutMs = 1500): Promise<ProbeResult> {
  if (endpoint.provider === "anthropic") {
    const key = await getBrainApiKey("anthropic").catch(() => null);
    return key ? { reachable: true, models: [], detail: "Anthropic API key saved" } : { reachable: false, models: [], detail: "No Anthropic API key saved" };
  }
  const base = normalizeBaseUrl(endpoint.baseUrl) ?? (endpoint.provider === "ollama" ? "http://localhost:11434" : null);
  if (!base) return { reachable: false, models: [], detail: "No server address" };
  const key = `${endpoint.provider}|${base}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.result;

  let result: ProbeResult;
  try {
    const url = endpoint.provider === "ollama" ? `${base}/api/tags` : `${base}/v1/models`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      result = { reachable: false, models: [], detail: `${base} answered ${res.status}` };
    } else {
      const data = (await res.json()) as { models?: Array<{ name?: string }>; data?: Array<{ id?: string }> };
      const models = (endpoint.provider === "ollama" ? (data.models ?? []).map((m) => m.name) : (data.data ?? []).map((m) => m.id))
        .filter((m): m is string => typeof m === "string" && m.length > 0)
        .sort();
      result = { reachable: true, models, detail: `${base} is up` };
    }
  } catch {
    result = { reachable: false, models: [], detail: `${base} isn't answering` };
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** The endpoint a role uses right now: its primary when that answers, else its fallback when that
 * answers, else none (the primary is reported, so the error names the server you expect). */
export async function resolveRole(config: TeamConfig, which: BrainRole, fetchImpl: Fetch = fetch): Promise<RoleStatus> {
  const settings = roleSettings(config, which);
  const primary = await probeEndpoint(settings.primary, fetchImpl);
  if (primary.reachable) return { role: which, using: "primary", endpoint: settings.primary, reachable: true, detail: withModel(primary, settings.primary) };
  if (settings.fallback) {
    const fallback = await probeEndpoint(settings.fallback, fetchImpl);
    if (fallback.reachable) {
      return { role: which, using: "fallback", endpoint: settings.fallback, reachable: true, detail: `${primary.detail}; using the fallback. ${withModel(fallback, settings.fallback)}` };
    }
    return { role: which, using: "none", endpoint: settings.primary, reachable: false, detail: `${primary.detail}, and the fallback: ${fallback.detail}` };
  }
  return { role: which, using: "none", endpoint: settings.primary, reachable: false, detail: primary.detail };
}

function withModel(probe: ProbeResult, endpoint: RoleEndpoint): string {
  if (!probe.models.length || probe.models.includes(endpoint.model)) return probe.detail;
  return `${probe.detail}, but it doesn't list "${endpoint.model}" (it has ${probe.models.slice(0, 6).join(", ")}${probe.models.length > 6 ? ", …" : ""})`;
}

export async function teamStatus(config: TeamConfig, fetchImpl: Fetch = fetch): Promise<RoleStatus[]> {
  return Promise.all((["head", "checker", "executor"] as BrainRole[]).map((r) => resolveRole(config, r, fetchImpl)));
}

/** A provider for a role, on whichever of its servers answers. */
export async function createRoleProvider(config: TeamConfig, which: BrainRole, fetchImpl: Fetch = fetch): Promise<{ provider: BrainProvider; status: RoleStatus }> {
  const status = await resolveRole(config, which, fetchImpl);
  if (!status.reachable || !status.endpoint) {
    throw new Error(`The ${which === "head" ? "Head" : which === "checker" ? "Checker" : "Executor"} model can't be reached: ${status.detail}.`);
  }
  return { provider: await createProviderFor(status.endpoint, { thinking: config.thinking }), status };
}
