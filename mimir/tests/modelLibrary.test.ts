import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchFile, fitFor, localPath, ModelDownloads, pickFiles, quantsIn, repoFiles } from "../src/main/models/library.js";
import { HermesInstaller, installSteps } from "../src/main/engines/hermesInstall.js";

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const temp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "mimir-models-")); dirs.push(d); return d; };

const TREE = [
  { type: "file", path: "README.md", size: 10 },
  { type: "file", path: "Qwen3.5-9B-UD-IQ3_XXS.gguf", size: 10, lfs: { size: 3_900_000_000 } },
  { type: "file", path: "Qwen3.5-9B-Q4_K_M.gguf", size: 10, lfs: { size: 5_600_000_000 } },
  { type: "file", path: "mmproj-BF16.gguf", size: 10, lfs: { size: 900_000_000 } },
  { type: "file", path: "mmproj-F16.gguf", size: 10, lfs: { size: 880_000_000 } },
  { type: "directory", path: "Q8_0" },
  { type: "file", path: "Q8_0/Qwen3.5-9B-Q8_0-00001-of-00002.gguf", size: 10, lfs: { size: 5e9 } },
  { type: "file", path: "Q8_0/Qwen3.5-9B-Q8_0-00002-of-00002.gguf", size: 10, lfs: { size: 4e9 } }
];

/** A Hugging Face stand-in: the tree API and file downloads that honour Range. */
function fakeHub(files: Record<string, Buffer>, opts: { failAfter?: number } = {}) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/models/")) {
      if (u.includes("nobody/none")) return new Response("", { status: 404 });
      return Response.json(TREE);
    }
    const name = decodeURIComponent(u.split("/resolve/main/")[1] ?? "");
    const data = files[name];
    if (!data) return new Response("", { status: 404 });
    const range = /bytes=(\d+)-/.exec(String((init?.headers as Record<string, string> | undefined)?.Range ?? ""));
    const from = range ? Number(range[1]) : 0;
    let body = data.subarray(from);
    if (opts.failAfter !== undefined && !range) body = body.subarray(0, opts.failAfter);
    return new Response(body, { status: range ? 206 : 200 });
  }) as typeof fetch;
}

describe("model library", () => {
  it("reads a repo's GGUF files and picks a quant, its parts, and the F16 projector", async () => {
    const files = await repoFiles("unsloth/Qwen3.5-9B-GGUF", fakeHub({}));
    expect(files.map((f) => f.path)).not.toContain("README.md");
    const { model, mmproj } = pickFiles(files, "UD-IQ3_XXS");
    expect(model.map((f) => f.path)).toEqual(["Qwen3.5-9B-UD-IQ3_XXS.gguf"]);
    expect(mmproj?.path).toBe("mmproj-F16.gguf");
    expect(pickFiles(files, "Q8_0").model.map((f) => f.path)).toEqual(["Q8_0/Qwen3.5-9B-Q8_0-00001-of-00002.gguf", "Q8_0/Qwen3.5-9B-Q8_0-00002-of-00002.gguf"]);
    expect(quantsIn(files).map((q) => q.quant)).toEqual(["UD-IQ3_XXS", "Q4_K_M", "Q8_0"]);
    await expect(repoFiles("nobody/none", fakeHub({}))).rejects.toThrow(/No public repo/);
    await expect(repoFiles("not a repo", fakeHub({}))).rejects.toThrow(/owner\/name/);
  });

  it("says whether a model fits on the Mac, on the PC's card, or not at all", () => {
    expect(fitFor(3.8 * GB, { disk: 50 * GB, ram: 8 * GB, vram: 0, computer: "mac" }).level).toBe("fits");
    expect(fitFor(4.5 * GB, { disk: 50 * GB, ram: 8 * GB, vram: 0, computer: "mac" }).level).toBe("tight");
    expect(fitFor(8 * GB, { disk: 50 * GB, ram: 8 * GB, vram: 0, computer: "mac" }).level).toBe("too-big");
    expect(fitFor(8 * GB, { disk: 50 * GB, ram: 16 * GB, vram: 12 * GB, computer: "pc" }).level).toBe("fits");
    expect(fitFor(20 * GB, { disk: 50 * GB, ram: 16 * GB, vram: 12 * GB, computer: "pc" }).level).toBe("tight");
    expect(fitFor(40 * GB, { disk: 80 * GB, ram: 16 * GB, vram: 12 * GB, computer: "pc" }).level).toBe("too-big");
    expect(fitFor(8 * GB, { disk: 5 * GB, ram: 16 * GB, vram: 12 * GB, computer: "pc" }).detail).toMatch(/disk/);
  });

  it("carries a download on from where it stopped", async () => {
    const dir = await temp();
    const data = Buffer.from("0123456789".repeat(1000));
    const dest = path.join(dir, "m.gguf");
    const url = "https://huggingface.co/a/b/resolve/main/m.gguf";
    // The first try is cut off after 4000 bytes.
    await expect(fetchFile(url, dest, data.length, () => {}, new AbortController().signal, fakeHub({ "m.gguf": data }, { failAfter: 4000 }))).rejects.toThrow(/stopped early/);
    expect((await readFile(`${dest}.part`)).length).toBe(4000);
    const seen: number[] = [];
    await fetchFile(url, dest, data.length, (n) => seen.push(n), new AbortController().signal, fakeHub({ "m.gguf": data }));
    expect(seen[0]).toBe(4000);
    expect((await readFile(dest)).equals(data)).toBe(true);
  });

  it("downloads a model with its projector beside it, lists it, and deletes it", async () => {
    const dir = await temp();
    const tree = TREE.map((f) => ({ ...f, lfs: f.lfs ? { size: 5 } : undefined }));
    const hub = (async (url: string | URL, init?: RequestInit) => (String(url).includes("/api/") ? Response.json(tree) : fakeHub({ "Qwen3.5-9B-UD-IQ3_XXS.gguf": Buffer.from("model"), "mmproj-F16.gguf": Buffer.from("proj!") })(url, init))) as typeof fetch;
    const library = new ModelDownloads(hub, dir);
    const job = await library.start("unsloth/Qwen3.5-9B-GGUF", "UD-IQ3_XXS");
    for (let i = 0; i < 50 && job.status === "downloading"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(job.status).toBe("done");
    expect(job.path).toBe(localPath("unsloth/Qwen3.5-9B-GGUF", "Qwen3.5-9B-UD-IQ3_XXS.gguf", dir));
    expect(await readFile(path.join(path.dirname(job.path), "mmproj-F16.gguf"), "utf8")).toBe("proj!");
    expect((await library.scan()).map((m) => m.file)).toEqual(["Qwen3.5-9B-UD-IQ3_XXS.gguf"]);
    await library.remove(job.id);
    expect(await library.scan()).toEqual([]);
    await expect(library.start("unsloth/Qwen3.5-9B-GGUF", "Q2_K")).rejects.toThrow(/no Q2_K/);
  });
});

describe("installing Hermes", () => {
  it("runs the installer without browser or computer use, then the ACP extra, Honcho, and the check", () => {
    const posix = installSteps({ platform: "linux", home: "/home/u", hermes: "/home/u/.local/bin/hermes", honcho: true });
    expect(posix.map((s) => s.label)).toEqual(["Installing Hermes", "Adding its ACP extra", "Adding the Honcho plugin", "Checking Hermes"]);
    expect(posix[0]!.args.join(" ")).toMatch(/install\.sh \| bash -s -- --non-interactive --skip-browser --skip-computer-use/);
    expect(posix.at(-1)!.args).toEqual(["acp", "--check"]);
    const win = installSteps({ platform: "win32", home: "C:\\Users\\u", hermes: "hermes", honcho: false });
    expect(win[0]!.command).toBe("powershell");
    expect(win[0]!.args.at(-1)).toMatch(/install\.ps1.*-NonInteractive -SkipBrowser -SkipComputerUse/);
    expect(win.map((s) => s.label)).not.toContain("Adding the Honcho plugin");
  });

  it("saves the command it found when the check passes, and stops on a failed installer", async () => {
    let saved = "";
    const ran: string[] = [];
    const ok = new HermesInstaller({ run: async (s, log) => { ran.push(s.label); log(`ran ${s.label}`); return s.label === "Adding its ACP extra" ? 1 : 0; }, find: async () => "/x/hermes", save: async (c) => { saved = c; } });
    ok.start({ configured: null, honcho: false });
    for (let i = 0; i < 50 && ok.state.running; i++) await new Promise((r) => setTimeout(r, 5));
    expect(ok.state).toMatchObject({ ok: true, command: "/x/hermes" });
    expect(saved).toBe("/x/hermes");
    expect(ran).toEqual(["Installing Hermes", "Adding its ACP extra", "Checking Hermes"]);

    const bad = new HermesInstaller({ run: async () => 1, find: async () => "/x/hermes", save: async () => { throw new Error("no"); } });
    bad.start({ configured: null, honcho: false });
    for (let i = 0; i < 50 && bad.state.running; i++) await new Promise((r) => setTimeout(r, 5));
    expect(bad.state.ok).toBe(false);
    expect(bad.state.log.at(-1)).toMatch(/installer failed/);
  });
});

