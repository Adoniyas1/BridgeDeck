import { isInside } from "../coding/tools.js";
import { AcpAgent } from "./acp.js";
import type { EngineResult, EngineTurn } from "./common.js";
import type { Upstream } from "./anthropicBridge.js";

/** OpenCode as Mimir's agent, over ACP (`opencode acp`; engines/acp.ts). */

type Json = Record<string, unknown>;

export interface OpenCodeModels {
  head: Upstream;
  executor: Upstream;
}

/** OpenCode's config for this run: the team's two models as OpenAI-compatible providers (or none,
 * to keep OpenCode's own), and the permission rules. */
export function openCodeConfig(models: OpenCodeModels | null, editsAllowed: boolean): Json {
  const config: Json = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    permission: { bash: "ask", edit: editsAllowed ? "allow" : "ask", webfetch: "allow", external_directory: "ask" }
  };
  if (models) {
    const provider = (name: string, u: Upstream) => ({
      npm: "@ai-sdk/openai-compatible",
      name,
      options: { baseURL: `${u.baseUrl}/v1`, ...(u.apiKey ? { apiKey: u.apiKey } : {}) },
      models: { [u.model]: { name: u.model, tool_call: true, ...(u.thinking !== undefined ? { options: { chat_template_kwargs: { enable_thinking: u.thinking } } } : {}) } }
    });
    config.provider = { "mimir-head": provider("Mimir Head", models.head), "mimir-executor": provider("Mimir Executor", models.executor) };
    config.model = `mimir-head/${models.head.model}`;
    config.small_model = `mimir-executor/${models.executor.model}`;
  }
  return config;
}

export { handleUpdate } from "./acp.js";

export class OpenCodeAgent {
  private acp = new AcpAgent("opencode");

  /** One message, with the team's models (or OpenCode's own). */
  run(turn: EngineTurn, options: { command: string; models: OpenCodeModels | null; mcpServers?: Json[] }): Promise<EngineResult> {
    const config = openCodeConfig(options.models, isInside(turn.projectsRoot, turn.cwd));
    const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: "1" };
    return this.acp.run(turn, { command: options.command, args: ["acp"], env, mcpServers: options.mcpServers }, JSON.stringify([options.command, config]));
  }

  stop(): void {
    this.acp.stop();
  }
}
