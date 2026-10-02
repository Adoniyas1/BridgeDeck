import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDef, ToolResult, Toolset } from "../brain/Provider.js";
import type { RunPythonFn } from "../compute/tools.js";
import { findSkill, frontMatter, loadPackSkills, rankSkills } from "./packs.js";

const MAX_READ = 30_000;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 3_000_000;
const TEXT_FILE = /\.(py|md|txt|json|ya?ml|csv|toml|ini|cfg|html|j2|jinja|tmpl|template)$/i;

/** Runs a skill's script in the Pyodide sandbox: its files are written into the
 * sandbox's in-memory file system, then the script runs as `__main__` with the
 * given command-line arguments, from a scratch folder holding any input files. */
export const RUN_SCRIPT = `
import io, os, runpy, sys
root = "/skillpack"
for rel, text in args["files"].items():
    target = os.path.join(root, rel)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w") as f:
        f.write(text)
work = os.path.join(root, "_work")
os.makedirs(work, exist_ok=True)
for name, text in args.get("inputs", {}).items():
    with open(os.path.join(work, os.path.basename(name)), "w") as f:
        f.write(text)
os.chdir(work)
script = os.path.join(root, args["script"])
sys.path[:0] = [os.path.dirname(script)]
sys.argv = [script] + list(args.get("argv", []))
sys.stdin = io.StringIO(args.get("stdin", ""))
before = set(os.listdir(work))
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as exit:
    if exit.code not in (None, 0):
        print(f"(the script exited with {exit.code})")
for name in sorted(set(os.listdir(work)) - before):
    path = os.path.join(work, name)
    if os.path.isfile(path):
        with open(path, errors="replace") as f:
            text = f.read()
        print(f"\\n--- wrote {name} ---\\n" + text[:6000] + ("\\n…" if len(text) > 6000 else ""))
`;

const ok = (content: string): ToolResult => ({ content: content.length > MAX_READ ? `${content.slice(0, MAX_READ)}\n…(cut short)` : content });
const fail = (message: string): ToolResult => ({ content: message, isError: true });
const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");

async function filesOf(dir: string, base = dir, depth = 0): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "__pycache__") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) out.push(...(await filesOf(full, base, depth + 1)));
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** A path inside the skill's folder, never outside it. */
function inside(dir: string, rel: string): string | null {
  const full = path.resolve(dir, rel);
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}

/** Expert skills from the packs chosen in BridgeDeck's Settings. */
export function buildSkillPacksToolset(opts: { root: string; runPython: RunPythonFn }): Toolset {
  const { root, runPython } = opts;
  const defs: ToolDef[] = [
    { name: "skill_find", description: "Find expert skills (step-by-step methods for research, studying, planning, writing, engineering, product and business work) in the skill packs the user installed. Check here when a task is a known kind of work; then skill_read the best match and follow it.", inputSchema: { type: "object", properties: { query: { type: "string", description: "The task in a few words, e.g. 'literature review', 'project risk register', 'code review'" } }, required: ["query"] } },
    { name: "skill_read", description: "Read a skill's instructions (SKILL.md), or one of its reference files, to follow it for the current task.", inputSchema: { type: "object", properties: { skill: { type: "string", description: "Skill name from skill_find" }, file: { type: "string", description: "Optional file inside the skill, e.g. references/checklist.md" } }, required: ["skill"] } },
    { name: "skill_run_script", description: "Run one of a skill's Python scripts (as its SKILL.md describes) in the sandbox. It has no access to the user's files: pass any input as `inputs` (file name to text) and command-line arguments as `argv`. Files it writes are shown in the answer.", inputSchema: { type: "object", properties: { skill: { type: "string" }, script: { type: "string", description: "Path inside the skill, e.g. scripts/risk_matrix.py" }, argv: { type: "array", items: { type: "string" } }, stdin: { type: "string" }, inputs: { type: "object", additionalProperties: { type: "string" } } }, required: ["skill", "script"] } }
  ];

  const handlers: Toolset["handlers"] = {
    skill_find: async (input) => {
      const skills = await loadPackSkills(root);
      if (!skills.length) return ok("No skill packs are installed. The user can choose some in BridgeDeck → Settings → Mimir → Skill packs.");
      const found = rankSkills(skills, str(input, "query"));
      if (!found.length) return ok(`No skill matches. Installed packs: ${[...new Set(skills.map((s) => s.pack))].join(", ")}.`);
      return ok(found.map((s) => `- ${s.name} (${s.pack}): ${s.description.length > 240 ? `${s.description.slice(0, 240)}…` : s.description}`).join("\n"));
    },
    skill_read: async (input) => {
      const skill = findSkill(await loadPackSkills(root), str(input, "skill"));
      if (!skill) return fail("No such skill; use skill_find.");
      const file = str(input, "file");
      if (file) {
        const full = inside(skill.dir, file);
        if (!full) return fail("That file isn't part of the skill.");
        const text = await readFile(full, "utf8").catch(() => null);
        return text === null ? fail("No such file in the skill.") : ok(text);
      }
      const { body } = frontMatter(await readFile(path.join(skill.dir, "SKILL.md"), "utf8"));
      const others = (await filesOf(skill.dir)).filter((f) => f !== "SKILL.md");
      return ok(`# Skill: ${skill.name} (${skill.pack})\n\n${body.trim()}${others.length ? `\n\n---\nFiles in this skill: ${others.join(", ")}` : ""}`);
    },
    skill_run_script: async (input) => {
      const skill = findSkill(await loadPackSkills(root), str(input, "skill"));
      if (!skill) return fail("No such skill; use skill_find.");
      const script = str(input, "script").replace(/\\/g, "/");
      if (!script.endsWith(".py") || !inside(skill.dir, script)) return fail("Give a .py script inside the skill.");
      const files: Record<string, string> = {};
      let total = 0;
      for (const rel of (await filesOf(skill.dir)).filter((f) => TEXT_FILE.test(f))) {
        const full = path.join(skill.dir, rel);
        const size = (await stat(full)).size;
        if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
        files[rel] = await readFile(full, "utf8");
        total += size;
      }
      if (!(script in files)) return fail("No such script in the skill.");
      const argv = Array.isArray(input.argv) ? input.argv.map(String) : [];
      const inputs = input.inputs && typeof input.inputs === "object" ? Object.fromEntries(Object.entries(input.inputs as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
      const result = await runPython(RUN_SCRIPT, { files, script, argv, stdin: str(input, "stdin"), inputs });
      const out = [result.stdout.trim(), result.result && result.result !== "None" ? result.result : ""].filter(Boolean).join("\n");
      return result.error ? fail(`${out ? `${out}\n` : ""}Error: ${result.error}`) : ok(out || "(no output)");
    }
  };
  return { defs, handlers };
}
