import { mkdir } from "node:fs/promises";
import type { TeamConfig } from "../../shared/types.js";
import { runClaudeCode } from "./claudeCode.js";
import { roleUpstream, type EngineResult, type EngineTurn } from "./common.js";
import { OpenCodeAgent } from "./openCode.js";

/** Runs a chat turn on Claude Code or OpenCode, keeping each one's conversation going between
 * messages (Claude Code by session id, OpenCode by keeping its process up). */
export class EngineRunner {
  private claude: { key: string; sessionId: string | null } = { key: "", sessionId: null };
  private openCode = new OpenCodeAgent();

  async run(team: TeamConfig, turn: EngineTurn): Promise<EngineResult> {
    await mkdir(turn.cwd, { recursive: true });
    const useTeam = team.engineModels === "team";
    if (team.engine === "claude-code") {
      const command = team.engineCommands["claude-code"] ?? "claude";
      // A new conversation when the folder or the models change; Claude Code's session is per folder.
      const key = JSON.stringify([command, turn.cwd, useTeam]);
      if (key !== this.claude.key) this.claude = { key, sessionId: null };
      const result = await runClaudeCode(turn, { command, team: useTeam ? team : null, resume: this.claude.sessionId });
      if (result.sessionId) this.claude.sessionId = result.sessionId;
      return result;
    }
    if (team.engine === "opencode") {
      const models = useTeam ? { head: await roleUpstream(team, "head"), executor: await roleUpstream(team, "executor") } : null;
      return this.openCode.run(turn, { command: team.engineCommands.opencode ?? "opencode", models });
    }
    throw new Error(`No engine called ${team.engine}`);
  }

  /** Forgets the conversations (a new chat). */
  reset(): void {
    this.claude = { key: "", sessionId: null };
    this.openCode.stop();
  }

  close(): void {
    this.openCode.stop();
  }
}
