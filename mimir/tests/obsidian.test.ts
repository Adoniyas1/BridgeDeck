import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildObsidianToolset, insideVault, resolveVault, searchVault, syncObsidian } from "../src/main/persona/obsidian.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const temp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "mimir-obsidian-")); dirs.push(d); return d; };

describe("Obsidian memory", () => {
  it("keeps Memory.md and About me.md the same both ways, the user's Obsidian edit winning", async () => {
    const root = await temp();
    const vault = path.join(root, "vault"), daily = path.join(root, "daily");
    await mkdir(vault); await mkdir(daily);
    await writeFile(path.join(daily, "2026-10-24.md"), "- talked about EE 310");
    const persona: Record<string, string> = { "MEMORY.md": "- likes circuits", "USER.md": "EE student" };
    const opts = { vault, dailyDir: daily, statePath: path.join(root, "state.json"), readPersona: async (f: string) => persona[f] ?? "", writePersona: async (f: string, t: string) => { persona[f] = t; } };

    expect(await syncObsidian(opts)).toEqual({ files: { "MEMORY.md": "pushed", "USER.md": "pushed" }, daily: 1 });
    expect(await readFile(path.join(vault, "Mimir", "About me.md"), "utf8")).toBe("EE student");
    expect(await readFile(path.join(vault, "Mimir", "Daily", "2026-10-24.md"), "utf8")).toBe("- talked about EE 310");

    // Mimir remembers something new: it goes to the vault.
    persona["MEMORY.md"] = "- likes circuits\n- exam Friday";
    expect((await syncObsidian(opts)).files["MEMORY.md"]).toBe("pushed");
    // Edited in Obsidian (and by Mimir too): the Obsidian edit wins.
    await writeFile(path.join(vault, "Mimir", "Memory.md"), "- likes circuits\n- exam moved to Monday");
    persona["MEMORY.md"] = "- something else";
    expect((await syncObsidian(opts)).files["MEMORY.md"]).toBe("pulled");
    expect(persona["MEMORY.md"]).toBe("- likes circuits\n- exam moved to Monday");
    expect(await syncObsidian(opts)).toEqual({ files: { "MEMORY.md": "same", "USER.md": "same" }, daily: 0 });
  });

  it("searches and reads the vault, and writes only under Mimir/Notes", async () => {
    const vault = await temp();
    await mkdir(path.join(vault, "Classes")); await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, "Classes", "EE 310.md"), "Thevenin equivalent: open-circuit voltage and the resistance seen.");
    await writeFile(path.join(vault, "Shopping.md"), "milk, eggs");
    await writeFile(path.join(vault, ".obsidian", "thevenin.md"), "hidden");
    expect((await searchVault(vault, "thevenin resistance")).map((h) => h.path)).toEqual(["Classes/EE 310.md"]);
    expect(insideVault(vault, "../outside.md")).toBeNull();
    const tools = buildObsidianToolset(vault);
    expect((await tools.handlers.obsidian_read({ path: "Classes/EE 310.md" })).content).toContain("Thevenin");
    expect((await tools.handlers.obsidian_read({ path: "../../etc/passwd" })).isError).toBe(true);
    expect((await tools.handlers.obsidian_write({ title: "Plan: week 9 / exams", markdown: "# Plan" })).content).toContain("Mimir/Notes/Plan- week 9 - exams.md");
    expect(await readFile(path.join(vault, "Mimir", "Notes", "Plan- week 9 - exams.md"), "utf8")).toBe("# Plan");
  });

  it("uses BridgeDeck's notes vault unless told not to, and saves notes through BridgeDeck", async () => {
    const bd = await temp(), own = await temp();
    const calls: Array<[string, Record<string, unknown>]> = [];
    let enabled = true;
    const client = { async call<T>(p: string, body: Record<string, unknown> = {}): Promise<T> { calls.push([p, body]); return (p === "vault" ? { enabled, path: bd } : { id: "n1" }) as T; } };
    expect(await resolveVault({ vault: own, useBridgeDeck: true }, client)).toEqual({ path: bd, bridgedeck: true });
    expect(await resolveVault({ vault: own, useBridgeDeck: false }, client)).toEqual({ path: own, bridgedeck: false });
    expect(await resolveVault({ vault: bd, useBridgeDeck: false }, client)).toEqual({ path: bd, bridgedeck: true });
    enabled = false;
    expect(await resolveVault({ vault: own, useBridgeDeck: true }, client)).toEqual({ path: own, bridgedeck: false });
    expect(await resolveVault({ vault: null }, null)).toBeNull();

    const tools = buildObsidianToolset(bd, client);
    expect((await tools.handlers.obsidian_write({ title: "Plan", markdown: "# Plan" })).isError).toBeFalsy();
    expect(calls.at(-1)).toEqual(["notes/create", { title: "Plan", folder: "Mimir/Notes", markdown: "# Plan" }]);
  });
});
