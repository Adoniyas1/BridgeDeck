import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PythonRunResult } from "../src/shared/types.js";
import { frontMatter, loadPackSkills, rankSkills, skillPacksRoot } from "../src/main/skillpacks/packs.js";
import { buildSkillPacksToolset, RUN_SCRIPT } from "../src/main/skillpacks/tools.js";

/** Stands in for the Pyodide sandbox: the same code and `args`, run by the local Python. */
function localPython(code: string, args: Record<string, unknown> = {}): Promise<PythonRunResult> {
  const sandbox = path.join(os.tmpdir(), `bd-pyodide-${Math.random().toString(36).slice(2)}`);
  const wrapped = `import json, sys\nargs = json.loads(sys.stdin.read())\n${code.replaceAll("/skillpack", sandbox)}`;
  const run = spawnSync("python3", ["-c", wrapped], { input: JSON.stringify(args), encoding: "utf8" });
  return Promise.resolve({ stdout: run.stdout, result: null, error: run.status === 0 ? null : run.stderr.trim().split("\n").pop() ?? "failed" });
}
const hasPython = spawnSync("python3", ["--version"]).status === 0;

async function packs() {
  const root = await mkdtemp(path.join(os.tmpdir(), "bd-packs-"));
  const skill = path.join(root, "project-management", "skills", "senior-pm");
  await mkdir(path.join(skill, "scripts"), { recursive: true });
  await mkdir(path.join(skill, "references"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), `---\nname: senior-pm\ndescription: >\n  Senior project manager: risk registers,\n  health dashboards and capacity planning.\nlicense: MIT\n---\n# Senior PM\nRun scripts/risk.py on a JSON risk register.\n`);
  await writeFile(path.join(skill, "references", "risk.md"), "Probability x impact.");
  await writeFile(path.join(skill, "scripts", "helpers.py"), "def score(r):\n    return r['p'] * r['i']\n");
  await writeFile(path.join(skill, "scripts", "risk.py"), [
    "import argparse, json", "from helpers import score",
    "p = argparse.ArgumentParser()", "p.add_argument('data_file')", "p.add_argument('--top', type=int, default=1)", "a = p.parse_args()",
    "risks = sorted(json.load(open(a.data_file)), key=score, reverse=True)",
    "print('Top risk:', risks[0]['name'], score(risks[0]))",
    "open('report.md', 'w').write('# Risks\\n' + '\\n'.join(r['name'] for r in risks[:a.top]))"
  ].join("\n"));
  const other = path.join(root, "research", "lit-review");
  await mkdir(other, { recursive: true });
  await writeFile(path.join(other, "SKILL.md"), `---\nname: literature-review\ndescription: "Systematic literature reviews: search, screen, \\"synthesise\\" sources."\n---\nSteps…`);
  await mkdir(path.join(root, "marketing-skill", "seo"), { recursive: true });
  await writeFile(path.join(root, "marketing-skill", "seo", "SKILL.md"), "---\nname: seo\ndescription: not installed\n---");
  await writeFile(path.join(root, "packs.json"), JSON.stringify({ installed: ["project-management", "research"] }));
  return root;
}

describe("skill packs", () => {
  it("are only offered when BridgeDeck passes an absolute folder", () => {
    expect(skillPacksRoot({})).toBeNull();
    expect(skillPacksRoot({ MIMIR_SKILL_PACKS: "relative" })).toBeNull();
    expect(skillPacksRoot({ MIMIR_SKILL_PACKS: "/data/skill-packs" })).toBe("/data/skill-packs");
  });

  it("reads front matter in its plain, quoted and folded forms", () => {
    expect(frontMatter("---\nname: a\ndescription: |\n  line one\n  line two\nother: x\n---\nBody").description).toBe("line one\nline two");
    expect(frontMatter("No front matter").name).toBe("");
  });

  it("lists the installed packs' skills and ranks them for a task", async () => {
    const root = await packs();
    const skills = await loadPackSkills(root);
    expect(skills.map((s) => `${s.pack}/${s.name}`)).toEqual(["project-management/senior-pm", "research/literature-review"]);
    expect(skills[0]!.description).toBe("Senior project manager: risk registers, health dashboards and capacity planning.");
    expect(skills[1]!.description).toBe('Systematic literature reviews: search, screen, "synthesise" sources.');
    expect(rankSkills(skills, "write a literature review on sources")[0]!.name).toBe("literature-review");
    expect(rankSkills(skills, "risk register for my project")[0]!.name).toBe("senior-pm");
    await rm(root, { recursive: true, force: true });
  });

  it("reads a skill's instructions and files, never outside it", async () => {
    const root = await packs();
    const tools = buildSkillPacksToolset({ root, runPython: localPython });
    const read = await tools.handlers.skill_read!({ skill: "senior-pm" });
    expect(read.content).toContain("# Skill: senior-pm (project-management)\n\n# Senior PM");
    expect(read.content).toContain("Files in this skill: references/risk.md, scripts/helpers.py, scripts/risk.py");
    expect((await tools.handlers.skill_read!({ skill: "senior-pm", file: "references/risk.md" })).content).toBe("Probability x impact.");
    expect((await tools.handlers.skill_read!({ skill: "senior-pm", file: "../../../packs.json" })).isError).toBe(true);
    expect((await tools.handlers.skill_find!({ query: "seo" })).content).toContain("No skill matches");
    expect((await tools.handlers.skill_run_script!({ skill: "senior-pm", script: "../../../x.py" })).isError).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(!hasPython)("runs a skill's script with its helpers, arguments and input files", async () => {
    const root = await packs();
    const tools = buildSkillPacksToolset({ root, runPython: localPython });
    const result = await tools.handlers.skill_run_script!({
      skill: "senior-pm", script: "scripts/risk.py", argv: ["risks.json", "--top", "2"],
      inputs: { "risks.json": JSON.stringify([{ name: "Supplier late", p: 3, i: 4 }, { name: "Scope creep", p: 4, i: 4 }, { name: "Rain", p: 1, i: 1 }]) }
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Top risk: Scope creep 16");
    expect(result.content).toContain("--- wrote report.md ---\n# Risks\nScope creep\nSupplier late");
    const bad = await tools.handlers.skill_run_script!({ skill: "senior-pm", script: "scripts/risk.py", argv: [] });
    expect(bad.content).toContain("exited with 2");
    expect(RUN_SCRIPT).not.toContain("${");
    await rm(root, { recursive: true, force: true });
  });
});
