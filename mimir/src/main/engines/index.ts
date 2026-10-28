import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TeamConfig } from "../../shared/types.js";
import { runClaudeCode } from "./claudeCode.js";
import { roleUpstream, type EngineResult, type EngineTurn } from "./common.js";
import { OpenCodeAgent } from "./openCode.js";
import { BORROWED_NOTE, contextHelp, HermesAgent, holdBack, NO_PROVIDER, NO_PROVIDER_HELP, type HonchoSettings } from "./hermes.js";
import { getSecret } from "../config/keychain.js";
import { ToolsEndpoint } from "./tools.js";

/** Where Honcho's API key is kept (the OS keychain). */
export const HONCHO_KEY = "honcho:api-key";

/** Runs a chat turn on Claude Code, OpenCode or Hermes, keeping each one's conversation going between
 * messages (Claude Code by session id, OpenCode by keeping its process up). */
export class EngineRunner {
  private claude: { key: string; sessionId: string | null } = { key: "", sessionId: null };
  private openCode = new OpenCodeAgent();
  private hermes = new HermesAgent();
  private tools = new ToolsEndpoint();
  /** The Hermes command found to have no AI provider of its own in this chat. */
  private hermesNoProvider: string | null = null;

  /** Hermes has no provider of its own: lend it the team's model for this message, or say how to give it one. */
  private async lendTeamModel(team: TeamConfig, turn: EngineTurn, opts: { command: string; honcho: HonchoSettings | null; mcpServers: Array<Record<string, unknown>> }): Promise<EngineResult> {
    const lent = await roleUpstream(team, "head").catch(() => null);
    if (!lent) throw new Error(NO_PROVIDER_HELP);
    turn.emit({ type: "text", text: BORROWED_NOTE });
    const result = await this.hermes.run(turn, { ...opts, model: lent, intro: turn.intro }).catch((err: unknown) => {
      const help = err instanceof Error ? contextHelp(err.message) : null;
      throw help ? new Error(help) : err;
    });
    return { text: BORROWED_NOTE + result.text };
  }

  async run(team: TeamConfig, turn: EngineTurn): Promise<EngineResult> {
    await mkdir(turn.cwd, { recursive: true });
    // Mimir's own tools go to the agent as an MCP server that calls back here.
    const withTools = !!turn.tools?.defs.length;
    if (turn.tools) this.tools.set(turn.tools);
    const acpServers = withTools ? [await this.tools.acpServer()] : [];
    const useTeam = team.engineModels === "team";
    if (team.engine === "claude-code") {
      const command = team.engineCommands["claude-code"] ?? "claude";
      // A new conversation when the folder or the models change; Claude Code's session is per folder.
      const key = JSON.stringify([command, turn.cwd, useTeam]);
      if (key !== this.claude.key) this.claude = { key, sessionId: null };
      const result = await runClaudeCode(turn, { command, team: useTeam ? team : null, resume: this.claude.sessionId, mimirTools: withTools ? await this.tools.claudeServer() : undefined });
      if (result.sessionId) this.claude.sessionId = result.sessionId;
      return result;
    }
    if (team.engine === "opencode") {
      const models = useTeam ? { head: await roleUpstream(team, "head"), executor: await roleUpstream(team, "executor") } : null;
      return this.openCode.run(turn, { command: team.engineCommands.opencode ?? "opencode", models, mcpServers: acpServers });
    }
    if (team.engine === "hermes") {
      const model = useTeam ? await roleUpstream(team, "head") : null;
      let honcho: HonchoSettings | null = null;
      if (team.honcho.enabled) {
        const apiKey = await getSecret(HONCHO_KEY).catch(() => null);
        if (!apiKey && !team.honcho.baseUrl) throw new Error("Honcho is on but has no API key or server address: add one in Settings → Brain team, or turn Honcho off.");
        honcho = { apiKey, baseUrl: team.honcho.baseUrl, peerName: team.honcho.peerName };
      }
      const command = team.engineCommands.hermes ?? "hermes";
      // Known since earlier in this chat: Hermes has no provider of its own, so go straight to the team's model.
      if (!useTeam && this.hermesNoProvider === command) return this.lendTeamModel(team, turn, { command, honcho, mcpServers: acpServers });
      const held = holdBack(turn);
      // Hermes says it has no provider either in its reply or as the error starting the session.
      const result = await this.hermes.run(held.turn, { command, model, honcho, intro: turn.intro, mcpServers: acpServers }).catch((err: unknown) => {
        if (err instanceof Error && NO_PROVIDER.test(err.message)) return null;
        const help = err instanceof Error ? contextHelp(err.message) : null;
        throw help ? new Error(help) : err;
      });
      if (result && !held.noProvider()) {
        held.release();
        return result;
      }
      if (useTeam) throw new Error("Hermes didn't take the Brain team's model from Mimir's profile (~/.mimir/hermes/config.yaml). Update Hermes (Install Hermes in BridgeDeck's Settings → Mimir) and try again.");
      this.hermesNoProvider = command;
      return this.lendTeamModel(team, turn, { command, honcho, mcpServers: acpServers });
    }
    throw new Error(`No engine called ${team.engine}`);
  }

  /** Forgets the conversations (a new chat). */
  reset(): void {
    this.claude = { key: "", sessionId: null };
    this.openCode.stop();
    this.hermes.stop();
    // A new chat tries Hermes's own provider again (it may have been set up with `hermes model`).
    this.hermesNoProvider = null;
  }

  close(): void {
    this.openCode.stop();
    this.hermes.stop();
    this.tools.close();
  }
}

/** How the chosen agent answered one tiny message (Settings → AI → Test my AI setup). */
export type EngineTry = { ok: boolean; ms: number; message: string; borrowed: boolean };

/** Sends the agent one short message, with nothing it may change, and says whether (and how fast)
 * it answered: the only way to know it's installed, signed in and has a working model. */
export async function tryEngine(team: TeamConfig, timeoutMs = 90_000, runner: Pick<EngineRunner, "run" | "close"> = new EngineRunner()): Promise<EngineTry> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-check-"));
  const signal = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  try {
    const result = await runner.run(team, {
      prompt: "This is a connection check from Mimir. Reply with exactly one word: ready",
      cwd: dir,
      projectsRoot: dir,
      approve: async () => false,
      emit: () => undefined,
      signal
    });
    const text = result.text.trim();
    return { ok: !!text, ms: Date.now() - started, message: text ? text.slice(0, 200) : "It answered with nothing.", borrowed: text.startsWith(BORROWED_NOTE.trim().slice(0, 40)) };
  } catch (err) {
    const message = signal.aborted ? `It didn't answer within ${Math.round(timeoutMs / 1000)} seconds (timed out).` : err instanceof Error ? err.message : String(err);
    return { ok: false, ms: Date.now() - started, message, borrowed: false };
  } finally {
    runner.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
