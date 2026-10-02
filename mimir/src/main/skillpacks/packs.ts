import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Skill packs BridgeDeck downloads for Mimir (src-tauri/src/skill_packs.rs):
 * folders of skills in the SKILL.md format — a Markdown file with `name` and
 * `description` front matter, plus optional references/ and stdlib-only
 * Python scripts/. BridgeDeck passes the folder as MIMIR_SKILL_PACKS. Only
 * the name and description are read up front; the rest is read when a task
 * calls for that skill.
 */
export interface PackSkill {
  name: string;
  description: string;
  pack: string;
  /** The folder holding SKILL.md. */
  dir: string;
}

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".incoming"]);
const MAX_DEPTH = 7;

export function skillPacksRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.MIMIR_SKILL_PACKS?.trim();
  return root && path.isAbsolute(root) ? root : null;
}

/** `name` and `description` from YAML front matter: plain, quoted, or a folded/literal block. */
export function frontMatter(markdown: string): { name: string; description: string; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { name: "", description: "", body: markdown };
  const lines = (match[1] ?? "").split(/\r?\n/);
  const value = (key: string) => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return "";
    let text = (lines[at] ?? "").slice(key.length + 1).trim();
    if (/^[>|][+-]?$/.test(text)) {
      const block: string[] = [];
      for (const line of lines.slice(at + 1)) {
        if (line.trim() && !/^\s/.test(line)) break;
        block.push(line.trim());
      }
      text = text.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
    } else if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).replace(text.startsWith('"') ? /\\"/g : /''/g, text.startsWith('"') ? '"' : "'");
    }
    return text;
  };
  return { name: value("name"), description: value("description"), body: markdown.slice(match[0].length) };
}

async function readState(root: string): Promise<{ installed: string[]; mtime: number }> {
  try {
    const file = path.join(root, "packs.json");
    const [raw, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const state = JSON.parse(raw) as { installed?: unknown };
    return { installed: Array.isArray(state.installed) ? state.installed.filter((p): p is string => typeof p === "string") : [], mtime: info.mtimeMs };
  } catch {
    return { installed: [], mtime: 0 };
  }
}

let cache: { root: string; mtime: number; skills: PackSkill[] } | null = null;

/** Every skill in the installed packs (re-read when BridgeDeck changes the packs). */
export async function loadPackSkills(root: string): Promise<PackSkill[]> {
  const state = await readState(root);
  if (cache && cache.root === root && cache.mtime === state.mtime) return cache.skills;
  const skills: PackSkill[] = [];
  const seen = new Set<string>();
  for (const pack of state.installed) {
    if (pack.includes("/") || pack.includes("\\") || pack.startsWith(".")) continue;
    const stack: Array<[string, number]> = [[path.join(root, pack), 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop()!;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
        const { name, description } = frontMatter(await readFile(path.join(dir, "SKILL.md"), "utf8").catch(() => ""));
        const id = (name || path.basename(dir)).trim();
        if (id && !seen.has(id.toLowerCase())) {
          seen.add(id.toLowerCase());
          skills.push({ name: id, description: description.replace(/\s+/g, " ").trim(), pack, dir });
        }
      }
      if (depth < MAX_DEPTH) for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) stack.push([path.join(dir, e.name), depth + 1]);
    }
  }
  skills.sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
  cache = { root, mtime: state.mtime, skills };
  return skills;
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Skills ranked for a task: words in the name count most, then the description. */
export function rankSkills(skills: PackSkill[], query: string, limit = 12): PackSkill[] {
  const terms = [...new Set(words(query))];
  if (!terms.length) return [];
  return skills
    .map((skill) => {
      const name = words(skill.name.replace(/-/g, " "));
      const description = words(skill.description);
      const score = terms.reduce((sum, t) => sum + (name.some((w) => w.startsWith(t) || t.startsWith(w)) ? 3 : 0) + (description.includes(t) ? 1 : 0), 0);
      return { skill, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map((s) => s.skill);
}

export function findSkill(skills: PackSkill[], name: string): PackSkill | undefined {
  const wanted = name.trim().toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === wanted) ?? skills.find((s) => s.name.toLowerCase().includes(wanted));
}
