import type { McpPreset, McpServerConfig } from "../../shared/types.js";
import { readJsonFile, writeJsonFile } from "../config/store.js";

/**
 * The MCP servers Mimir starts and takes tools from, kept per computer in ~/.mimir/mcp.json. Any
 * server that speaks the Model Context Protocol over stdio works; the presets are the official
 * reference servers (github.com/modelcontextprotocol/servers).
 */
const FILE = "mcp.json";

export interface McpConfig {
  servers: McpServerConfig[];
}

const ID_RE = /^[a-zA-Z0-9_-]{1,24}$/;

export function mcpPresets(projectsRoot: string): McpPreset[] {
  const server = (s: Omit<McpServerConfig, "env" | "enabled" | "trusted">): McpServerConfig => ({ env: {}, enabled: true, trusted: false, ...s });
  return [
    {
      id: "files",
      name: "Filesystem",
      description: "Read, write, move and search files in your Projects folder (and only there).",
      needs: "Node.js (BridgeDeck already has it).",
      server: server({ id: "files", name: "Filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", projectsRoot], keywords: ["directory", "folder tree", "move the file", "rename the file"] })
    },
    {
      id: "fetch",
      name: "Fetch",
      description: "Fetch a web page and turn it into text the model can read.",
      needs: "uv (Python's package runner): https://docs.astral.sh/uv/",
      server: server({ id: "fetch", name: "Fetch", command: "uvx", args: ["mcp-server-fetch"], keywords: ["fetch", "url", "web page", "http", "https"] })
    },
    {
      id: "git",
      name: "Git",
      description: "Read history, diffs and branches of a git repository, and commit to it.",
      needs: "uv (Python's package runner) and git.",
      server: server({ id: "git", name: "Git", command: "uvx", args: ["mcp-server-git", "--repository", projectsRoot], keywords: ["git", "commit", "branch", "diff", "repository", "repo"] })
    },
    {
      id: "thinking",
      name: "Sequential thinking",
      description: "A scratchpad tool for working through a hard problem step by step.",
      needs: "Node.js (BridgeDeck already has it).",
      server: server({ id: "thinking", name: "Sequential thinking", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"], keywords: ["step by step", "think it through", "reason carefully"] })
    }
  ];
}

/** A valid server entry from whatever was stored or sent, or null if it can't be one. */
export function cleanServer(raw: unknown): McpServerConfig | null {
  const s = (raw ?? {}) as Partial<McpServerConfig>;
  const id = typeof s.id === "string" ? s.id.trim() : "";
  const command = typeof s.command === "string" ? s.command.trim() : "";
  if (!ID_RE.test(id) || !command) return null;
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 500)).slice(0, max) : []);
  const env: Record<string, string> = {};
  if (s.env && typeof s.env === "object") {
    for (const [k, v] of Object.entries(s.env)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string") env[k] = v.slice(0, 2000);
  }
  return {
    id,
    name: typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 60) : id,
    command: command.slice(0, 500),
    args: strings(s.args, 40),
    env,
    enabled: s.enabled !== false,
    keywords: strings(s.keywords, 20).map((k) => k.trim()).filter(Boolean),
    trusted: s.trusted === true
  };
}

export function cleanMcpConfig(raw: unknown): McpConfig {
  const list = Array.isArray((raw as McpConfig | null)?.servers) ? (raw as McpConfig).servers : [];
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const item of list) {
    const server = cleanServer(item);
    if (server && !seen.has(server.id)) {
      seen.add(server.id);
      servers.push(server);
    }
  }
  return { servers };
}

export async function loadMcpConfig(): Promise<McpConfig> {
  return cleanMcpConfig(await readJsonFile<unknown>(FILE, { servers: [] }));
}

export async function saveMcpConfig(config: McpConfig): Promise<McpConfig> {
  const next = cleanMcpConfig(config);
  await writeJsonFile(FILE, next);
  return next;
}
