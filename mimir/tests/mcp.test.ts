import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager, mcpToolName, serverPath } from "../src/main/mcp/manager.js";
import { cleanMcpConfig, mcpPresets } from "../src/main/mcp/config.js";
import { loadPromptModules } from "../src/main/prompts/loader.js";
import type { McpServerConfig } from "../src/shared/types.js";
import type { Approver } from "../src/main/approvals.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-notes-server.mjs");
const notesServer = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: "notes", name: "Notes", command: process.execPath, args: [fixture], env: {}, enabled: true, keywords: ["jotting"], trusted: false, ...over
});

let manager: McpManager | null = null;
afterEach(async () => {
  await manager?.closeAll();
  manager = null;
});

describe("MCP servers", () => {
  it("starts a stdio server and lists its tools", async () => {
    manager = new McpManager();
    const server = notesServer();
    await manager.ensure([server]);
    const [status] = manager.status([server]);
    expect(status).toMatchObject({ id: "notes", state: "ready", error: null });
    expect(status!.tools).toEqual([
      { name: "list_notes", description: "List the notes.", readOnly: true },
      { name: "add_note", description: "Add a note.", readOnly: false }
    ]);
  }, 30_000);

  it("runs read-only tools straight away and asks before tools that change things", async () => {
    manager = new McpManager();
    const server = notesServer();
    await manager.ensure([server]);
    const asked: string[] = [];
    let allow = false;
    const approve: Approver = async (req) => { asked.push(`${req.title} | ${req.detail}`); return allow; };
    const { defs, handlers, modules } = manager.toolset([server], approve);
    expect(defs.map((d) => d.name)).toEqual(["mcp_notes_list_notes", "mcp_notes_add_note"]);
    expect(defs[1]!.description).toBe("Notes: Add a note.");

    expect(await handlers.mcp_notes_list_notes!({})).toMatchObject({ content: "first note", isError: false });
    expect(asked).toEqual([]);

    expect(await handlers.mcp_notes_add_note!({ text: "milk" })).toEqual({ content: "The user didn't allow this.", isError: true });
    expect(asked[0]).toContain("Notes wants to run add_note");
    expect(asked[0]).toContain('"text": "milk"');

    allow = true;
    expect(await handlers.mcp_notes_add_note!({ text: "milk" })).toMatchObject({ content: "Added. 2 notes.", isError: false });
    expect((await handlers.mcp_notes_list_notes!({})).content).toBe("first note\nmilk");

    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({ id: "mcp:notes", title: "Notes", tools: ["mcp_notes_list_notes", "mcp_notes_add_note"] });
  }, 30_000);

  it("doesn't ask for a trusted server", async () => {
    manager = new McpManager();
    const server = notesServer({ trusted: true });
    await manager.ensure([server]);
    let asked = 0;
    const { handlers } = manager.toolset([server], async () => { asked++; return false; });
    expect((await handlers.mcp_notes_add_note!({ text: "x" })).isError).toBe(false);
    expect(asked).toBe(0);
  }, 30_000);

  it("loads a server's tools only when a message is about it", async () => {
    manager = new McpManager();
    const server = notesServer();
    await manager.ensure([server]);
    const { modules } = manager.toolset([server], async () => false);
    const load = (userText: string) => loadPromptModules({ tier: "core", mode: "lazy", userText, extraModules: modules });
    expect(load("hi").toolNames?.has("mcp_notes_list_notes")).toBe(false);
    expect(load("show my jotting list").toolNames?.has("mcp_notes_list_notes")).toBe(true);
    expect(load("check Notes").loaded.map((m) => m.id)).toContain("mcp:notes");
  }, 30_000);

  it("reports a server that can't start, and stops ones that are turned off", async () => {
    manager = new McpManager();
    const broken = notesServer({ id: "broken", name: "Broken", command: "definitely-not-a-command-xyz", args: [] });
    const good = notesServer();
    await manager.ensure([broken, good]);
    const [b] = manager.status([broken]);
    expect(b!.state).toBe("failed");
    expect(b!.error).toContain("“definitely-not-a-command-xyz” isn't installed, or isn't on PATH.");
    expect(manager.toolset([broken], async () => false).defs).toEqual([]);

    await manager.ensure([{ ...good, enabled: false }]);
    expect(manager.status([{ ...good, enabled: false }])[0]!.state).toBe("off");
  }, 30_000);

  it("adds the usual install folders to PATH, once", () => {
    expect(serverPath("/usr/bin:/opt/homebrew/bin", "/Users/me", "darwin")).toBe("/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin:/Users/me/.cargo/bin:/Users/me/.mimir/bin:/Users/me/.mimir/bin/llama.cpp");
    expect(serverPath("C:\\Windows", "C:\\Users\\me", "win32")).toBe("C:\\Windows;C:\\Users\\me\\.mimir\\bin;C:\\Users\\me\\.mimir\\bin\\llama.cpp;C:\\Users\\me\\.local\\bin");
  });

  it("names tools in characters every provider accepts", () => {
    expect(mcpToolName("my server", "do.thing/now")).toBe("mcp_my_server_do_thing_now");
    expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
  });
});

describe("MCP config", () => {
  it("keeps valid servers and drops bad or repeated ones", () => {
    const cfg = cleanMcpConfig({ servers: [
      { id: "ok", command: "npx", args: ["-y", "pkg", 3], env: { GOOD_KEY: "1", "bad key": "x" } },
      { id: "bad id!", command: "npx" },
      { id: "nocmd", command: " " },
      { id: "ok", command: "other" }
    ] });
    expect(cfg.servers).toEqual([{ id: "ok", name: "ok", command: "npx", args: ["-y", "pkg"], env: { GOOD_KEY: "1" }, enabled: true, keywords: [], trusted: false }]);
  });

  it("offers the official reference servers, pointed at the Projects folder", () => {
    const presets = mcpPresets("/Users/me/Projects");
    expect(presets.map((p) => p.id)).toEqual(["files", "fetch", "git", "thinking"]);
    expect(presets[0]!.server.args).toContain("/Users/me/Projects");
    for (const p of presets) expect(cleanMcpConfig({ servers: [p.server] }).servers).toEqual([p.server]);
  });
});
