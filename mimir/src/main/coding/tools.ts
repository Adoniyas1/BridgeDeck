import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import type { ToolDef, ToolResult, Toolset } from "../brain/Provider.js";
import { preview, type Approver } from "../approvals.js";
import { fetchPublic, htmlToText } from "../web/tools.js";

/**
 * Coding tools shaped like Claude Code's (Read, Write, Edit, Glob, Grep, Bash, WebFetch, TodoWrite),
 * so models trained on agent work use them well. They work in a coding folder chosen in Settings
 * (the Projects folder by default). Safety:
 *  - Bash always asks the user first.
 *  - Write and Edit ask first for any file outside the Projects folder.
 *  - Read, Glob and Grep ask first outside both the coding folder and Projects.
 */

export interface CodingToolsetOptions {
  /** Where relative paths start and commands run. */
  root: string;
  /** Changes inside this folder don't ask (the user's Projects). */
  projectsRoot: string;
  approve: Approver;
  fetcher?: typeof fetch;
}

const READ_LINES = 2000;
const LINE_CHARS = 2000;
const OUTPUT_CHARS = 30_000;
const MAX_FILES = 20_000;
const MAX_GREP_FILE_BYTES = 1_000_000;
const BASH_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next", ".cache"]);

/** The to-do list the model keeps with TodoWrite (one per Mimir process). */
let todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = [];

export const CODING_TOOL_NAMES = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "TodoWrite"] as const;

export function isInside(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function buildCodingToolset(opts: CodingToolsetOptions): Toolset {
  const { root, projectsRoot, approve } = opts;
  const resolve = (p: unknown): string => {
    const raw = typeof p === "string" ? p.trim() : "";
    if (!raw) throw new Error("Give a path.");
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
  };
  const show = (abs: string) => (isInside(root, abs) ? path.relative(root, abs) || "." : abs);

  async function mayRead(abs: string, tool: string): Promise<boolean> {
    if (isInside(root, abs) || isInside(projectsRoot, abs)) return true;
    return approve({ tool, title: `Read outside the coding folder: ${abs}`, detail: `${tool} wants to read ${abs}, which is outside ${root}.` });
  }
  async function mayChange(abs: string, tool: string, detail: string): Promise<boolean> {
    if (isInside(projectsRoot, abs)) return true;
    return approve({ tool, title: `${tool === "Write" ? "Write" : "Change"} a file outside Projects: ${abs}`, detail });
  }

  const defs: ToolDef[] = [
    {
      name: "Read",
      description: "Read a text file. Returns lines numbered from 1 (like cat -n). Use offset and limit for long files.",
      inputSchema: { type: "object", properties: { file_path: { type: "string", description: "Path, relative to the coding folder or absolute" }, offset: { type: "number", description: "First line to read (1-based)" }, limit: { type: "number", description: "How many lines" } }, required: ["file_path"] }
    },
    {
      name: "Write",
      description: "Create or overwrite a file with the given content. Prefer Edit for changing an existing file.",
      inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] }
    },
    {
      name: "Edit",
      description: "Change a file by replacing exact text. old_string must match the file exactly (whitespace included) and be unique, unless replace_all is true. Read the file first.",
      inputSchema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"] }
    },
    {
      name: "Glob",
      description: "Find files by name pattern, e.g. \"**/*.py\" or \"src/**/*.ts\". Returns paths, newest first.",
      inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "Folder to search (default: the coding folder)" } }, required: ["pattern"] }
    },
    {
      name: "Grep",
      description: "Search file contents with a regular expression. output_mode: files_with_matches (default), content (matching lines with numbers) or count.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "File or folder (default: the coding folder)" },
          glob: { type: "string", description: "Only files matching this, e.g. \"*.ts\"" },
          output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
          case_insensitive: { type: "boolean" }
        },
        required: ["pattern"]
      }
    },
    {
      name: "Bash",
      description: "Run a shell command in the coding folder (the user approves each one). Returns its output and exit code. Default timeout 2 minutes, at most 10.",
      inputSchema: { type: "object", properties: { command: { type: "string" }, description: { type: "string", description: "What it does, in a few words" }, timeout: { type: "number", description: "Milliseconds" } }, required: ["command"] }
    },
    {
      name: "WebFetch",
      description: "Fetch a public web page and return it as text.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
    },
    {
      name: "TodoWrite",
      description: "Keep a to-do list for multi-step work: send the whole list each time, each item with content and status (pending, in_progress, completed).",
      inputSchema: {
        type: "object",
        properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } },
        required: ["todos"]
      }
    }
  ];

  const handlers: Toolset["handlers"] = {
    Read: guard(async (input) => {
      const abs = resolve(input.file_path);
      if (!(await mayRead(abs, "Read"))) return denied();
      const info = await stat(abs).catch(() => null);
      if (!info) return fail(`${show(abs)} doesn't exist.`);
      if (info.isDirectory()) return fail(`${show(abs)} is a folder; use Glob to list it.`);
      const text = await readFile(abs, "utf-8");
      if (text.includes("\u0000")) return fail(`${show(abs)} looks like a binary file.`);
      const lines = text.split(/\r?\n/);
      const from = Math.max(1, Math.floor(num(input.offset) ?? 1));
      const count = Math.min(Math.max(1, Math.floor(num(input.limit) ?? READ_LINES)), READ_LINES);
      const shown = lines.slice(from - 1, from - 1 + count).map((l, i) => `${String(from + i).padStart(6)}\t${l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l}`);
      const more = from - 1 + count < lines.length ? `\n… ${lines.length - (from - 1 + count)} more lines (use offset ${from + count})` : "";
      return ok(shown.join("\n") + more || "(empty file)");
    }),
    Write: guard(async (input) => {
      const abs = resolve(input.file_path);
      const content = typeof input.content === "string" ? input.content : "";
      if (!(await mayChange(abs, "Write", `${abs}\n\n${preview(content)}`))) return denied();
      await mkdir(path.dirname(abs), { recursive: true });
      const existed = existsSync(abs);
      await writeFile(abs, content, "utf-8");
      return ok(`${existed ? "Overwrote" : "Created"} ${show(abs)} (${content.split("\n").length} lines).`);
    }),
    Edit: guard(async (input) => {
      const abs = resolve(input.file_path);
      const oldString = typeof input.old_string === "string" ? input.old_string : "";
      const newString = typeof input.new_string === "string" ? input.new_string : "";
      if (!oldString) return fail("old_string can't be empty; use Write to create a file.");
      if (oldString === newString) return fail("old_string and new_string are the same.");
      const text = await readFile(abs, "utf-8").catch(() => null);
      if (text === null) return fail(`${show(abs)} doesn't exist.`);
      const count = text.split(oldString).length - 1;
      if (count === 0) return fail(`old_string wasn't found in ${show(abs)}. Read the file and copy the text exactly.`);
      if (count > 1 && input.replace_all !== true) return fail(`old_string appears ${count} times in ${show(abs)}; add more surrounding lines to make it unique, or set replace_all.`);
      if (!(await mayChange(abs, "Edit", `${abs}\n\n- ${preview(oldString, 700)}\n+ ${preview(newString, 700)}`))) return denied();
      const next = input.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
      await writeFile(abs, next, "utf-8");
      return ok(`Edited ${show(abs)} (${input.replace_all === true ? `${count} replacements` : "1 replacement"}).`);
    }),
    Glob: guard(async (input) => {
      const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
      if (!pattern) return fail("Give a pattern, e.g. **/*.py");
      const base = input.path ? resolve(input.path) : root;
      if (!(await mayRead(base, "Glob"))) return denied();
      const match = picomatch(pattern, { dot: false });
      const found: Array<{ rel: string; mtime: number }> = [];
      for await (const file of walk(base)) {
        const rel = path.relative(base, file).split(path.sep).join("/");
        if (match(rel) || (!pattern.includes("/") && match(path.basename(file)))) found.push({ rel, mtime: (await stat(file).catch(() => null))?.mtimeMs ?? 0 });
      }
      found.sort((a, b) => b.mtime - a.mtime);
      return ok(found.length ? cap(found.map((f) => f.rel).join("\n")) : "No files match.");
    }),
    Grep: guard(async (input) => {
      const source = typeof input.pattern === "string" ? input.pattern : "";
      if (!source) return fail("Give a pattern.");
      let re: RegExp;
      try {
        re = new RegExp(source, input.case_insensitive === true ? "i" : "");
      } catch (e) {
        return fail(`That isn't a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
      }
      const base = input.path ? resolve(input.path) : root;
      if (!(await mayRead(base, "Grep"))) return denied();
      const filter = typeof input.glob === "string" && input.glob.trim() ? picomatch(input.glob.trim(), { basename: true }) : null;
      const mode = input.output_mode === "content" || input.output_mode === "count" ? input.output_mode : "files_with_matches";
      const out: string[] = [];
      const info = await stat(base).catch(() => null);
      if (!info) return fail(`${show(base)} doesn't exist.`);
      const files = info.isFile() ? [base] : walk(base);
      for await (const file of files) {
        const rel = info.isFile() ? show(file) : path.relative(base, file).split(path.sep).join("/");
        if (filter && !filter(rel)) continue;
        const size = (await stat(file).catch(() => null))?.size ?? 0;
        if (size > MAX_GREP_FILE_BYTES) continue;
        const text = await readFile(file, "utf-8").catch(() => "");
        if (text.includes("\u0000")) continue;
        const lines = text.split(/\r?\n/);
        const hits = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => re.test(l));
        if (!hits.length) continue;
        if (mode === "files_with_matches") out.push(rel);
        else if (mode === "count") out.push(`${rel}:${hits.length}`);
        else for (const [n, l] of hits) out.push(`${rel}:${n}:${l.length > 300 ? `${l.slice(0, 300)}…` : l}`);
        if (out.join("\n").length > OUTPUT_CHARS) break;
      }
      return ok(out.length ? cap(out.join("\n")) : "No matches.");
    }),
    Bash: guard(async (input) => {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      if (!command) return fail("Give a command.");
      const what = typeof input.description === "string" && input.description.trim() ? input.description.trim() : "Run a command";
      if (!(await approve({ tool: "Bash", title: `${what} (in ${root})`, detail: command }))) return denied();
      const timeout = Math.min(Math.max(1000, num(input.timeout) ?? BASH_TIMEOUT_MS), BASH_MAX_TIMEOUT_MS);
      const { output, code, timedOut } = await runShell(command, root, timeout);
      const status = timedOut ? `Stopped after ${Math.round(timeout / 1000)} s.` : `Exit code ${code}.`;
      return { content: `${cap(output) || "(no output)"}\n${status}`, isError: timedOut || code !== 0 };
    }),
    WebFetch: guard(async (input) => {
      const fetched = await fetchPublic(typeof input.url === "string" ? input.url.trim() : "", { fetcher: opts.fetcher });
      const { title, text } = fetched.type.includes("html") ? htmlToText(fetched.body, fetched.url) : { title: "", text: fetched.body };
      return ok(cap(`# ${title || fetched.url}\n${fetched.url}\n\n${text}`));
    }),
    TodoWrite: guard(async (input) => {
      const list = Array.isArray(input.todos) ? input.todos : [];
      todos = list
        .map((t) => t as Record<string, unknown>)
        .filter((t) => typeof t.content === "string" && t.content.trim())
        .map((t) => ({ content: String(t.content).trim().slice(0, 300), status: t.status === "in_progress" || t.status === "completed" ? t.status : "pending" }));
      const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
      return ok(todos.length ? todos.map((t) => `${mark[t.status]} ${t.content}`).join("\n") : "The to-do list is empty.");
    })
  };

  return { defs, handlers };
}

/** Files under `dir`, skipping dependency and build folders, at most MAX_FILES. */
async function* walk(dir: string): AsyncGenerator<string> {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (++seen > MAX_FILES) return;
        yield full;
      }
    }
  }
}

export function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ output: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    const child = windows
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd, windowsHide: true })
      : spawn(existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", ["-c", command], { cwd, detached: true });
    let output = "";
    const add = (chunk: Buffer) => {
      if (output.length < OUTPUT_CHARS * 2) output += chunk.toString();
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (!windows && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: String(err), code: null, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output: output.trimEnd(), code, timedOut });
    });
  });
}

function guard(fn: (input: Record<string, unknown>) => Promise<ToolResult>) {
  return async (input: Record<string, unknown>): Promise<ToolResult> => {
    try {
      return await fn(input);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function cap(text: string): string {
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n… (cut: ${text.length - OUTPUT_CHARS} more characters)` : text;
}

const ok = (content: string): ToolResult => ({ content });
const fail = (content: string): ToolResult => ({ content, isError: true });
const denied = (): ToolResult => fail("The user didn't allow this.");
