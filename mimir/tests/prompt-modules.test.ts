import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { estimateTokens, loadPromptModules, STICKY_TURNS } from "../src/main/prompts/loader.js";
import { coreToolNames, CORE_MODULE_ID, moduleForTool, PROMPT_MODULES } from "../src/main/prompts/modules.js";
import { listBuiltInCapabilities, listPromptModules } from "../src/main/skills/builtins.js";
import { BRIDGEDECK_CORE_TOOLS, buildBridgeDeckToolset } from "../src/main/bridgedeck/tools.js";
import { buildSkillPacksToolset } from "../src/main/skillpacks/tools.js";
import { buildSelfEditToolset } from "../src/main/self-edit/tools.js";
import { SelfEditTransaction } from "../src/main/self-edit/transaction.js";

const loadedIds = (opts: Parameters<typeof loadPromptModules>[0]) => loadPromptModules(opts).loaded.map((m) => m.id);

describe("prompt modules", () => {
  it("tells Mimir where it runs and what it can do when asked", () => {
    for (const q of ["how aware are you of the app you are running in", "what tools are you aware of you having accss to", "what can you do?", "who are you"]) {
      const load = loadPromptModules({ tier: "core", mode: "lazy", userText: q });
      expect(load.loaded.map((m) => m.id), q).toContain("about");
      expect(load.sections.join("\n")).toMatch(/BridgeDeck/);
      expect(load.sections.join("\n")).toMatch(/- BridgeDeck notes: /);
      expect(load.toolNames!.size).toBe(0);
    }
    expect(loadedIds({ tier: "core", mode: "lazy", userText: "hi" })).toEqual([CORE_MODULE_ID]);
    // The core tier's list leaves out what only larger models have.
    const core = loadPromptModules({ tier: "core", mode: "lazy", userText: "what can you do" }).sections.join("\n");
    expect(core).not.toMatch(/- Self-edit|- Web/);
  });

  it("makes only the core module required", () => {
    expect(PROMPT_MODULES.filter((m) => m.required).map((m) => m.id)).toEqual([CORE_MODULE_ID]);
  });

  it("has unique ids and gives every optional module a way to load", () => {
    expect(new Set(PROMPT_MODULES.map((m) => m.id)).size).toBe(PROMPT_MODULES.length);
    for (const m of PROMPT_MODULES.filter((m) => !m.required)) expect(m.triggers.length).toBeGreaterThan(0);
  });

  it("gives each tool to exactly one module and keeps coreTools inside tools", () => {
    const owners = new Map<string, string>();
    for (const m of PROMPT_MODULES) {
      for (const tool of m.tools) {
        expect(owners.has(tool), `${tool} is owned by both ${owners.get(tool)} and ${m.id}`).toBe(false);
        owners.set(tool, m.id);
      }
      for (const tool of m.coreTools) expect(m.tools, `${m.id}.coreTools has ${tool}`).toContain(tool);
      if (!m.tiers.includes("core")) expect(m.coreTools, `${m.id} is full-only`).toEqual([]);
    }
  });

  it("owns every real tool Mimir builds, so a tool can never be unreachable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimir-modules-"));
    try {
      const caps = await listBuiltInCapabilities(root, path.join(root, "audit.json"));
      for (const cap of caps) expect(moduleForTool(cap.name), `${cap.name} has no prompt module`).toBeDefined();

      const stub = {} as never;
      const bridgedeck = buildBridgeDeckToolset({ call: async () => ({}) } as never);
      for (const d of bridgedeck.defs) expect(moduleForTool(d.name), `${d.name} has no prompt module`).toBeDefined();
      const packs = buildSkillPacksToolset({ root, runPython: stub });
      for (const d of packs.defs) expect(moduleForTool(d.name), `${d.name} has no prompt module`).toBeDefined();
      const selfEdit = buildSelfEditToolset({ workspaceRoot: root, transaction: new SelfEditTransaction(root, path.join(root, "a.json")), gate: stub, getAutoApproveCoreEdits: async () => false });
      for (const d of selfEdit.defs) expect(moduleForTool(d.name), `${d.name} has no prompt module`).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the BridgeDeck core tools and the core tier in sync", () => {
    const core = coreToolNames();
    for (const tool of BRIDGEDECK_CORE_TOOLS) expect(core.has(tool)).toBe(true);
    for (const tool of ["run_python", "create_skill", "list_skills", "run_skill", "list_project_files", "read_project_file", "write_project_file", "memory_replace"]) {
      expect(core.has(tool)).toBe(true);
    }
    for (const tool of ["propose_edit", "export_to_pdf", "tasks_replace", "message_send", "web_lookup"]) expect(core.has(tool)).toBe(false);
  });

  it("has no soul or identity module, tool or text", () => {
    const everything = JSON.stringify(PROMPT_MODULES.map((m) => [m.id, m.text, m.coreText, m.tools]));
    expect(everything).not.toMatch(/soul|identity/i);
  });
});

describe("loadPromptModules (lazy)", () => {
  const base = { tier: "core", mode: "lazy" } as const;

  it("sends only the core module, and no tools, for a greeting", () => {
    const result = loadPromptModules({ ...base, userText: "hi" });
    expect(result.loaded.map((m) => m.id)).toEqual([CORE_MODULE_ID]);
    expect([...(result.toolNames ?? [])]).toEqual([]);
  });

  it("loads a module for what the user asked, and only that module's tools", () => {
    const result = loadPromptModules({ ...base, userText: "what is 14% of 230?" });
    expect(result.loaded.map((m) => m.id)).toEqual([CORE_MODULE_ID, "compute"]);
    expect([...(result.toolNames ?? [])]).toEqual(["run_python"]);
    expect(result.sections.join("\n")).toContain("run_python");
    expect(result.sections.join("\n")).not.toContain("memory_replace");
  });

  it("loads several modules when the message needs several", () => {
    const ids = loadedIds({ ...base, userText: "remember that my report is due Friday and save it to a file" });
    expect(ids).toEqual(expect.arrayContaining(["memory", "projects"]));
  });

  it("loads the module that owns a tool the user names outright", () => {
    expect(loadedIds({ ...base, userText: "call write_project_file for me" })).toContain("projects");
  });

  it("does not load a module because an ordinary word happens to be a tool name", () => {
    // self_edit owns a tool called plain "search".
    const ids = loadedIds({ tier: "full", mode: "lazy", userText: "research and search my notes for the lab report" });
    expect(ids).not.toContain("self_edit");
  });

  it("keeps a matched module for the next turns, then lets it go", () => {
    const sticky = new Map([["compute", STICKY_TURNS]]);
    const result = loadPromptModules({ ...base, userText: "and now double it", sticky });
    expect(result.loaded.find((m) => m.id === "compute")?.reason).toBe("sticky");
    expect(loadedIds({ ...base, userText: "and now double it", sticky: new Map() })).toEqual([CORE_MODULE_ID]);
  });

  it("never offers a tier's tools to the wrong tier", () => {
    const small = loadPromptModules({ ...base, userText: "search the web, then edit your own code and send a message" });
    expect(small.loaded.map((m) => m.id)).not.toContain("web");
    expect(small.loaded.map((m) => m.id)).not.toContain("self_edit");
    expect(small.skipped.find((m) => m.id === "self_edit")?.reason).toBe("tier");
    const large = loadPromptModules({ tier: "full", mode: "lazy", userText: "edit your own code" });
    expect(large.toolNames).toContain("propose_edit");
  });

  it("skips a tools-only module when its tools do not exist this turn", () => {
    const result = loadPromptModules({ ...base, userText: "what is on my calendar tomorrow?", availableTools: new Set(["run_python"]) });
    expect(result.loaded.map((m) => m.id)).not.toContain("bd_calendar");
    expect(result.skipped.find((m) => m.id === "bd_calendar")?.reason).toBe("unavailable");
  });

  it("loads optional modules one by one and stops at the budget", () => {
    const cost = (name: string) => (name === "create_skill" ? 1000 : 100);
    const result = loadPromptModules({
      ...base,
      userText: "teach yourself a skill to calculate this and remember it, then write a file",
      toolCost: cost,
      budgetTokens: 600
    });
    const ids = result.loaded.map((m) => m.id);
    // Modules are tried in registry order; the ones that no longer fit are skipped, not loaded half-way.
    expect(ids).toEqual(expect.arrayContaining(["memory", "projects"]));
    for (const id of ["compute", "skills"]) {
      expect(ids).not.toContain(id);
      expect(result.skipped.find((m) => m.id === id)?.reason).toBe("over budget");
    }
    expect(result.tokens).toBeLessThanOrEqual(600 + estimateTokens(PROMPT_MODULES[0]!.text));
  });

  it("offers the user's own skill tools with the Skills module or when named", () => {
    const dynamicSkillTools = ["skill_resistor_color_code"];
    expect(loadPromptModules({ ...base, userText: "hi", dynamicSkillTools }).toolNames?.has("skill_resistor_color_code")).toBe(false);
    expect(loadPromptModules({ ...base, userText: "decode this resistor color code", dynamicSkillTools }).toolNames?.has("skill_resistor_color_code")).toBe(true);
    expect(loadPromptModules({ ...base, userText: "use my skills", dynamicSkillTools }).toolNames?.has("skill_resistor_color_code")).toBe(true);
  });
});

describe("loadPromptModules (all)", () => {
  it("describes every capability a full-tier model has, with no tool filtering", () => {
    const result = loadPromptModules({ tier: "full", mode: "all" });
    expect(result.toolNames).toBeNull();
    expect(result.sections.join("\n")).toContain("propose_edit");
    expect(result.sections.join("\n")).toContain("tasks_replace");
  });

  it("limits the core tier to its curated tools", () => {
    const result = loadPromptModules({ tier: "core", mode: "all" });
    expect(result.toolNames).toEqual(coreToolNames());
    expect(result.sections.join("\n")).not.toContain("propose_edit");
  });

  it("honours exclude", () => {
    expect(loadPromptModules({ tier: "full", mode: "all", exclude: ["self_edit"] }).sections.join("\n")).not.toContain("propose_edit");
  });
});

describe("what a small model is sent", () => {
  it("is far smaller than the old always-on prompt for a greeting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimir-catalog-"));
    try {
      const modules = await listPromptModules(root, path.join(root, "audit.json"));
      const core = modules.find((m) => m.id === CORE_MODULE_ID)!;
      expect(core.coreTokens).toBeLessThan(250);
      // The old always-on core set was ~3,000 tokens of tool schemas plus a ~560-token prompt.
      const everything = modules.reduce((sum, m) => sum + m.coreTokens, 0);
      expect(core.coreTokens).toBeLessThan(everything / 10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
