import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodingToolset, isInside } from "../src/main/coding/tools.js";
import type { Approver } from "../src/main/approvals.js";

let base: string;
let projects: string;
let code: string;
let asked: string[];
let allow: boolean;
const approve: Approver = async (req) => { asked.push(`${req.tool}: ${req.title}`); return allow; };
const tools = () => buildCodingToolset({ root: code, projectsRoot: projects, approve }).handlers;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "mimir-coding-"));
  projects = path.join(base, "Projects");
  code = path.join(projects, "app");
  await mkdir(path.join(code, "src"), { recursive: true });
  await mkdir(path.join(code, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(code, "src", "main.py"), "def add(a, b):\n    return a - b\n\nprint(add(2, 3))\n");
  await writeFile(path.join(code, "src", "util.ts"), "export const x = 1;\n");
  await writeFile(path.join(code, "node_modules", "dep", "index.js"), "def add() {}\n");
  asked = [];
  allow = false;
});
afterEach(async () => rm(base, { recursive: true, force: true }));

describe("coding tools", () => {
  it("reads with line numbers and pages long files", async () => {
    const r = await tools().Read!({ file_path: "src/main.py" });
    expect(r.content).toBe("     1\tdef add(a, b):\n     2\t    return a - b\n     3\t\n     4\tprint(add(2, 3))\n     5\t");
    const page = await tools().Read!({ file_path: "src/main.py", offset: 2, limit: 1 });
    expect(page.content).toMatch(/^ {5}2\t {4}return a - b\n… 3 more lines \(use offset 3\)$/);
    expect((await tools().Read!({ file_path: "nope.py" })).isError).toBe(true);
  });

  it("edits exact, unique text, and explains when it can't", async () => {
    const t = tools();
    expect(await t.Edit!({ file_path: "src/main.py", old_string: "return a - b", new_string: "return a + b" })).toEqual({ content: "Edited src/main.py (1 replacement)." });
    expect(await readFile(path.join(code, "src", "main.py"), "utf-8")).toContain("return a + b");
    expect((await t.Edit!({ file_path: "src/main.py", old_string: "missing", new_string: "x" })).content).toMatch(/wasn't found/);
    await writeFile(path.join(code, "twice.txt"), "a\na\n");
    expect((await t.Edit!({ file_path: "twice.txt", old_string: "a", new_string: "b" })).content).toMatch(/appears 2 times/);
    expect((await t.Edit!({ file_path: "twice.txt", old_string: "a", new_string: "$&b", replace_all: true })).isError).toBeFalsy();
    expect(await readFile(path.join(code, "twice.txt"), "utf-8")).toBe("$&b\n$&b\n");
    expect(asked).toEqual([]);
  });

  it("writes inside Projects freely, and asks before changing anything outside it", async () => {
    const t = tools();
    expect((await t.Write!({ file_path: "new/notes.md", content: "hi" })).content).toBe("Created new/notes.md (1 lines).");
    const outside = path.join(base, "elsewhere.txt");
    expect(await t.Write!({ file_path: outside, content: "x" })).toEqual({ content: "The user didn't allow this.", isError: true });
    expect(asked[0]).toMatch(/^Write: Write a file outside Projects/);
    allow = true;
    expect((await t.Write!({ file_path: outside, content: "x" })).isError).toBeFalsy();
  });

  it("asks before reading outside the coding and Projects folders", async () => {
    const secret = path.join(base, "secret.txt");
    await writeFile(secret, "token");
    expect((await tools().Read!({ file_path: secret })).isError).toBe(true);
    expect(asked[0]).toMatch(/^Read: Read outside the coding folder/);
    expect((await tools().Read!({ file_path: path.join(projects, "app", "src", "util.ts") })).isError).toBeFalsy();
  });

  it("finds files by pattern, skipping dependency folders", async () => {
    expect((await tools().Glob!({ pattern: "**/*.py" })).content).toBe("src/main.py");
    expect((await tools().Glob!({ pattern: "*.ts" })).content).toBe("src/util.ts");
    expect((await tools().Glob!({ pattern: "**/*.rb" })).content).toBe("No files match.");
  });

  it("searches contents in three output modes", async () => {
    const t = tools();
    expect((await t.Grep!({ pattern: "def add" })).content).toBe("src/main.py");
    expect((await t.Grep!({ pattern: "add", output_mode: "content" })).content).toBe("src/main.py:1:def add(a, b):\nsrc/main.py:4:print(add(2, 3))");
    expect((await t.Grep!({ pattern: "ADD", case_insensitive: true, output_mode: "count" })).content).toBe("src/main.py:2");
    expect((await t.Grep!({ pattern: "x", glob: "*.ts" })).content).toBe("src/util.ts");
    expect((await t.Grep!({ pattern: "(" })).isError).toBe(true);
  });

  it("asks before every command, then runs it in the coding folder", async () => {
    const t = tools();
    expect(await t.Bash!({ command: "echo hi", description: "Say hi" })).toEqual({ content: "The user didn't allow this.", isError: true });
    expect(asked[0]).toBe(`Bash: Say hi (in ${code})`);
    allow = true;
    const r = await t.Bash!({ command: process.platform === "win32" ? "Get-Location" : "pwd && echo oops >&2 && exit 3" });
    expect(r.content).toContain(code);
    expect(r.content).toContain("Exit code 3.");
    expect(r.isError).toBe(true);
  });

  it("stops a command that runs too long", async () => {
    allow = true;
    const r = await tools().Bash!({ command: "sleep 5", timeout: 1000 });
    expect(r.content).toContain("Stopped after 1 s.");
  }, 10_000);

  it("keeps a to-do list", async () => {
    const r = await tools().TodoWrite!({ todos: [{ content: "Fix add", status: "completed" }, { content: "Run tests", status: "in_progress" }, { content: "", status: "pending" }] });
    expect(r.content).toBe("[x] Fix add\n[~] Run tests");
  });

  it("knows what's inside a folder", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a/b/../c")).toBe(false);
  });
});
