import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildComposedSystemPrompt, composeSystemPrompt } from "../src/main/persona/compose.js";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mimir-persona-test-"));
  await mkdir(path.join(workspaceRoot, "persona"), { recursive: true });
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

const persona = (file: string, content: string) => writeFile(path.join(workspaceRoot, "persona", file), content, "utf-8");

describe("system prompt composition", () => {
  it("always says who Mimir is, with no identity or soul step", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot);
    expect(prompt).toContain("You are Mimir");
    expect(prompt).not.toMatch(/soul|identity/i);
  });

  it("ignores leftover SOUL.md and IDENTITY.md files from older versions", async () => {
    await persona("IDENTITY.md", "# Identity\n\nI am very elaborate.\n");
    await persona("SOUL.md", "# Soul\n\nDiscuss my personality.\n");
    const prompt = await buildComposedSystemPrompt(workspaceRoot);
    expect(prompt).not.toContain("very elaborate");
    expect(prompt).not.toContain("Discuss my personality");
    expect(prompt).not.toContain("You don't have an identity yet");
  });

  it("uses a compact, tool-free system prompt when there are no tools", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot, { memoryMaxChars: 0, dailyLogDays: 0, includeToolInstructions: false });
    expect(prompt).toContain("Never claim to have changed a file");
    expect(prompt).not.toContain("propose_edit");
    expect(prompt).not.toContain("run_python");
  });

  it("adds only the supplied focused action to a tool-free local prompt", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot, {
      memoryMaxChars: 0,
      dailyLogDays: 0,
      includeToolInstructions: false,
      localToolInstructions: "You have one available action: create a cable guide."
    });
    expect(prompt).toContain("create a cable guide");
    expect(prompt).not.toContain("propose_edit");
    expect(prompt).not.toContain("run_python");
  });

  it("keeps the user profile out of a local prompt but includes it by default", async () => {
    await persona("USER.md", "# User\n\nPrivate profile text.\n");
    expect(await buildComposedSystemPrompt(workspaceRoot, { includeUserProfile: false, memoryMaxChars: 0, dailyLogDays: 0 })).not.toContain("Private profile text");
    expect(await buildComposedSystemPrompt(workspaceRoot)).toContain("Private profile text");
  });

  it("injects TASKS.md as an upcoming-deadlines section when it has content", async () => {
    await persona("TASKS.md", "- Problem set 3 — due Thursday\n");
    const prompt = await buildComposedSystemPrompt(workspaceRoot);
    expect(prompt).toContain("# Upcoming deadlines and tasks (TASKS.md)");
    expect(prompt).toContain("Problem set 3");
  });

  it("omits the TASKS.md section entirely when there are no tasks", async () => {
    expect(await buildComposedSystemPrompt(workspaceRoot)).not.toContain("Upcoming deadlines and tasks");
  });

  it("truncates a long MEMORY.md to its most recent characters", async () => {
    await persona("MEMORY.md", `OLD-FACT ${"x".repeat(5000)} NEW-FACT`);
    const prompt = await buildComposedSystemPrompt(workspaceRoot, { memoryMaxChars: 100 });
    expect(prompt).toContain("NEW-FACT");
    expect(prompt).not.toContain("OLD-FACT");
  });

  it("describes every capability and its tools on the full tier", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot, { toolTier: "full", mode: "all" });
    for (const tool of ["memory_replace", "tasks_replace", "run_python", "write_project_file", "create_skill", "propose_edit"]) {
      expect(prompt).toContain(tool);
    }
  });

  it("leaves out self-editing when told to", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot, { mode: "all", exclude: ["self_edit"] });
    expect(prompt).toContain("memory_replace");
    expect(prompt).not.toContain("propose_edit");
  });

  it("gives the core tier only the tools it actually has", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot, { toolTier: "core", mode: "all" });
    for (const tool of ["run_python", "create_skill", "memory_replace", "write_project_file"]) expect(prompt).toContain(tool);
    // Describing a tool the model cannot call is what made small models write tool-call JSON into the chat.
    for (const tool of ["propose_edit", "export_to_pdf", "tasks_replace", "semantic_search_project_files"]) expect(prompt).not.toContain(tool);
  });

  it("in lazy mode, a greeting gets the core paragraph and nothing else", async () => {
    const composed = await composeSystemPrompt(workspaceRoot, { toolTier: "core", mode: "lazy", userText: "hi", memoryMaxChars: 0, dailyLogDays: 0 });
    expect(composed.loaded.map((m) => m.id)).toEqual(["core"]);
    expect(composed.system).toContain("You are Mimir");
    expect(composed.system).not.toContain("run_python");
    expect([...(composed.toolNames ?? [])]).toEqual([]);
  });

  it("in lazy mode, asking for a calculation loads exactly the calculation module", async () => {
    const composed = await composeSystemPrompt(workspaceRoot, { toolTier: "core", mode: "lazy", userText: "convert 5 miles to km", memoryMaxChars: 0, dailyLogDays: 0 });
    expect(composed.loaded.map((m) => m.id)).toEqual(["core", "compute"]);
    expect(composed.system).toContain("run_python");
    expect([...(composed.toolNames ?? [])]).toEqual(["run_python"]);
  });
});
