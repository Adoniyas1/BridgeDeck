import { loadBrainConfig } from "../brain/config.js";
import { bridgeDeckFromEnv } from "../bridgedeck/client.js";
import { getSecret } from "../config/keychain.js";
import { checkEngine, roleUpstream } from "../engines/common.js";
import { findHermes } from "../engines/hermesInstall.js";
import { HONCHO_KEY, tryEngine } from "../engines/index.js";
import { freeDisk } from "../models/library.js";
import { loadSetupConfig } from "../setup/index.js";
import { loadTeamConfig } from "../team/config.js";
import { clearProbeCache, probeEndpoint, teamStatus } from "../team/endpoints.js";
import { runAiChecks, type AiCheck } from "./aiCheck.js";

/** Gathers how things stand now (fresh, not from the probe cache) and checks it. */
export async function checkAi(): Promise<AiCheck[]> {
  clearProbeCache();
  const [team, brain, setup] = await Promise.all([loadTeamConfig(), loadBrainConfig(), loadSetupConfig()]);
  const ownModels = team.engine !== "mimir" && team.engineModels === "own";
  const single = team.mode === "single" && brain.provider !== "anthropic" && !ownModels;
  const client = bridgeDeckFromEnv();
  const [roles, brainServer, engine, agentModel, honchoKey, bridgedeck, freeDiskBytes] = await Promise.all([
    team.mode === "team" && !ownModels ? teamStatus(team) : Promise.resolve([]),
    single ? probeEndpoint({ provider: brain.provider, model: brain.model, baseUrl: brain.baseUrl }, fetch, 3000) : Promise.resolve(null),
    team.engine === "mimir" ? Promise.resolve(null)
      : team.engine === "hermes" ? findHermes(team.engineCommands.hermes).then((found) => (found ? { ok: true, detail: `Installed (${found})` } : { ok: false, detail: "Hermes isn't installed, or its command isn't found." }))
      : checkEngine(team.engine, team.engineCommands[team.engine] ?? (team.engine === "claude-code" ? "claude" : team.engine)),
    team.engine === "hermes" && !ownModels ? roleUpstream(team, "head").catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) : Promise.resolve(null),
    team.honcho.enabled ? getSecret(HONCHO_KEY).then(Boolean).catch(() => false) : Promise.resolve(false),
    client ? client.call<{ enabled: boolean }>("vault").then((v) => ({ reachable: true, vault: !!v.enabled })).catch(() => ({ reachable: false, vault: false })) : Promise.resolve(null),
    freeDisk().catch(() => null)
  ]);
  // A found agent is sent one short message: the only way to know it's signed in and has a model.
  const engineReply = team.engine !== "mimir" && engine?.ok ? await tryEngine(team) : null;
  return runAiChecks({ team, brain, setup, roles, brainServer, engine, engineReply, agentModel, honchoKey, bridgedeck, freeDiskBytes });
}
