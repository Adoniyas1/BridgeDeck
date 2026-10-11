import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Decouple this test from whatever brain provider happens to be configured
// on the real machine (createBrainProvider() reads ~/.mimir/brain.json,
// outside this test's control) — force the "no usable provider" path so
// the assertion below is deterministic rather than depending on local state.
vi.mock("../src/main/brain/index.js", () => ({
  createBrainProvider: vi.fn().mockRejectedValue(new Error("no provider configured in this test"))
}));

const { listBuiltInCapabilities } = await import("../src/main/skills/builtins.js");

let workspaceRoot: string;
let auditFilePath: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mimir-builtins-test-"));
  auditFilePath = path.join(workspaceRoot, "audit.json");
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("listBuiltInCapabilities", () => {
  it("lists the always-available native tools, matching the real toolset builders", async () => {
    const caps = await listBuiltInCapabilities(workspaceRoot, auditFilePath);
    const names = caps.map((c) => c.name);
    expect(names).toContain("memory_replace");
    expect(names).toContain("tasks_replace");
    expect(names).toContain("run_python");
    expect(names).toContain("write_project_file");
    expect(names).toContain("create_skill");
    expect(names).toContain("run_skill");
  });

  it("groups tools into the expected categories", async () => {
    const caps = await listBuiltInCapabilities(workspaceRoot, auditFilePath);
    const categories = new Set(caps.map((c) => c.category));
    expect(categories).toEqual(new Set(["Coding", "Memory", "Deadlines", "Project files", "Calculations", "Skills", "Engineering tools", "Web research"]));
  });

  it("never lists a soul or identity tool", async () => {
    const caps = await listBuiltInCapabilities(workspaceRoot, auditFilePath);
    expect(caps.map((c) => c.name).filter((n) => /soul|identity/.test(n))).toEqual([]);
  });

  it("names the prompt module that owns each tool", async () => {
    const caps = await listBuiltInCapabilities(workspaceRoot, auditFilePath);
    expect(caps.find((c) => c.name === "run_python")?.module).toBe("compute");
    for (const cap of caps) expect(cap.module).not.toBe("");
  });

  it("degrades gracefully (no throw, no Self-Edit section) when no provider can be resolved", async () => {
    const caps = await listBuiltInCapabilities(workspaceRoot, auditFilePath);
    expect(caps.some((c) => c.category === "Self-Edit")).toBe(false);
  });

  it("every capability has a non-empty name and description", async () => {
    const caps = await listBuiltInCapabilities(workspaceRoot, auditFilePath);
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      expect(cap.name.length).toBeGreaterThan(0);
      expect(cap.description.length).toBeGreaterThan(0);
    }
  });
});
