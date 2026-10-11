import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanSetupConfig, cmdPath, mergeSetupConfig, defaultSetup, isLocalModel, localSwapUrl, MAC_ARGS, memoryNeeded, pickAssets, releaseTool, swapYaml } from "../src/main/setup/plan.js";
import { checkRoom, parseVmStat } from "../src/main/setup/memory.js";
import { findLocal, installRelease, modelCached, pickModels, storageItems } from "../src/main/setup/index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tempDir() {
  const d = await mkdtemp(path.join(os.tmpdir(), "mimir-setup-"));
  dirs.push(d);
  return d;
}

describe("model server plan", () => {
  it("writes llama-swap's config: GGUF files with llama.cpp on the Mac, -hf downloads on the PC", () => {
    const mac = { ...defaultSetup("mac"), models: { head: { name: "qwen3.5-9b", source: "/Users/me/Bonsai-demo/models/qwen3.5-9b/Qwen3.5-9B-UD-IQ3_XXS.gguf", args: MAC_ARGS }, executor: { name: "bonsai-8b", source: "/Users/me/Bonsai-demo/models/ternary-gguf/8B/Ternary-Bonsai-8B-PQ2_0.gguf", args: MAC_ARGS } } };
    const yaml = swapYaml(mac, "/Users/me/Bonsai-demo/bin/mac/llama-server");
    expect(yaml).toContain('"qwen3.5-9b":\n    cmd: "/Users/me/Bonsai-demo/bin/mac/llama-server -m /Users/me/Bonsai-demo/models/qwen3.5-9b/Qwen3.5-9B-UD-IQ3_XXS.gguf --host 127.0.0.1 --port ${PORT} -c 8192 -ngl 99 -fa on -ctk q4_0 -ctv q4_0 --jinja"');
    expect(yaml).toContain("-m /Users/me/Bonsai-demo/models/ternary-gguf/8B/Ternary-Bonsai-8B-PQ2_0.gguf");
    expect(yaml).toContain("ttl: 600");
    expect(yaml).not.toContain("groups:");
    expect(defaultSetup("mac").models.head.source).toBe("unsloth/Qwen3.5-9B-GGUF:UD-IQ3_XXS");

    const pc = swapYaml({ ...defaultSetup("pc"), keepBothLoaded: true }, "C:\\Users\\Jo Smith\\.mimir\\bin\\llama.cpp\\llama-server.exe");
    expect(pc).toContain(`cmd: "'C:/Users/Jo Smith/.mimir/bin/llama.cpp/llama-server.exe' -hf unsloth/Qwen3.5-35B-A3B-GGUF:UD-Q4_K_XL --host 127.0.0.1 --port \${PORT} -c 32768 -ngl 99 --n-cpu-moe 24 --jinja"`);
    expect(pc).toContain('groups:\n  "team":\n    swap: false\n    exclusive: true\n    members:\n      - "qwen3.5-35b-a3b"\n      - "qwen3.5-9b"');
    expect(cmdPath("/usr/bin/llama-server")).toBe("/usr/bin/llama-server");
  });

  it("cleans the settings, and replaces the old MLX models on the Mac", () => {
    expect(cleanSetupConfig({}, "darwin")).toEqual(defaultSetup("mac"));
    expect(cleanSetupConfig({}, "win32")).toMatchObject({ computer: "pc", listen: "0.0.0.0:8080" });
    const oldMac = { computer: "mac", models: { head: { name: "qwen3.5-9b", source: "mlx-community/Qwen3.5-9B-OptiQ-4bit", args: "" }, executor: { name: "bonsai-8b", source: "prism-ml/Ternary-Bonsai-8B-mlx-2bit", args: "" } } };
    expect(cleanSetupConfig(oldMac, "darwin").models).toEqual(defaultSetup("mac").models);
    const local = "/Users/me/models/Qwen3.5-9B-UD-IQ3_XXS.gguf";
    const kept = cleanSetupConfig({ ...defaultSetup("mac"), models: { ...defaultSetup("mac").models, head: { name: "qwen3.5-9b", source: local, args: "-c 4096" } } }, "darwin");
    expect(kept.models.head).toEqual({ name: "qwen3.5-9b", source: local, args: "-c 4096" });
    const messy = cleanSetupConfig({ version: 2, computer: "mac", listen: "nope", models: { head: { name: "x y", source: "not a repo; rm -rf /", args: "a\nb" } } }, "darwin");
    expect(messy.listen).toBe("127.0.0.1:8080");
    expect(messy.models.head).toEqual({ ...defaultSetup("mac").models.head, args: "a b" });
    expect(localSwapUrl(defaultSetup("pc"))).toBe("http://127.0.0.1:8080");

    const pc = { ...defaultSetup("pc"), autostart: true };
    const mac = mergeSetupConfig(pc, { computer: "mac", listen: "127.0.0.1:18090" });
    expect(mac).toEqual({ ...defaultSetup("mac"), autostart: true, listen: "127.0.0.1:18090" });
    expect(isLocalModel("C:\\models\\a.gguf")).toBe(true);
    expect(isLocalModel("unsloth/Qwen3.5-9B-GGUF:Q4_K_M")).toBe(false);
  });

  it("estimates how much memory a model needs", () => {
    const GB = 1024 ** 3;
    expect(memoryNeeded("/x/Qwen3.5-9B-UD-IQ3_XXS.gguf", 3.6 * GB) / GB).toBeCloseTo(4.4, 1);
    expect(memoryNeeded("prism-ml/Ternary-Bonsai-8B-gguf:PQ2_0", null) / GB).toBeCloseTo(3.1, 1);
    expect(memoryNeeded("unsloth/Qwen3.5-35B-A3B-GGUF:UD-Q4_K_XL", null) / GB).toBeGreaterThan(20);
  });

  it("picks the right release files, with a CUDA runtime that matches the build", () => {
    const names = (list: string[]) => list.map((name) => ({ name }));
    const swapMac = releaseTool("llama-swap", "darwin", "arm64")!;
    expect(pickAssets(swapMac, names(["llama-swap_200_linux_amd64.tar.gz", "llama-swap_200_darwin_arm64.tar.gz"])).map((a) => a.name)).toEqual(["llama-swap_200_darwin_arm64.tar.gz"]);
    expect(pickAssets(releaseTool("llama-swap", "win32", "x64")!, names(["llama-swap_200_windows_amd64.zip"]))).toHaveLength(1);

    const prism = releaseTool("llama.cpp", "darwin", "arm64")!;
    expect(prism.repo).toBe("PrismML-Eng/llama.cpp");
    expect(pickAssets(prism, names(["llama-prism-b10772-e8fd209-bin-macos-x64.tar.gz", "llama-prism-b10772-e8fd209-bin-macos-arm64.tar.gz"]))[0]!.name).toBe("llama-prism-b10772-e8fd209-bin-macos-arm64.tar.gz");

    const cpp = releaseTool("llama.cpp", "win32", "x64")!;
    const files = names([
      "llama-b7000-bin-win-cpu-x64.zip",
      "llama-b7000-bin-win-cuda-13.1-x64.zip",
      "cudart-llama-bin-win-cuda-13.1-x64.zip",
      "llama-b7000-bin-win-cuda-12.4-x64.zip",
      "cudart-llama-bin-win-cuda-12.4-x64.zip"
    ]);
    expect(pickAssets(cpp, files).map((a) => a.name)).toEqual(["llama-b7000-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"]);
    expect(() => pickAssets(cpp, names(["llama-b7000-bin-win-cpu-x64.zip"]))).toThrow(/no file for this computer/);
    expect(releaseTool("llama.cpp", "linux", "x64")).toBeNull();
  });
});

describe("memory guard", () => {
  const GB = 1024 ** 3;
  const config = { ...defaultSetup("mac"), models: { head: { name: "qwen3.5-9b", source: "unsloth/Qwen3.5-9B-GGUF:UD-IQ3_XXS", args: "" }, executor: { name: "bonsai-8b", source: "prism-ml/Ternary-Bonsai-8B-gguf:PQ2_0", args: "" } } };
  const deps = (free: number, running: string[] = [], ollama: string[] = []) => ({ available: async () => free * GB, running: async () => running, ollama: async () => ollama });

  it("reads vm_stat", () => {
    const text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      1000.\nPages active:   9999.\nPages inactive:   2000.\nPages speculative:  500.\nPages purgeable:  100.\n";
    expect(parseVmStat(text)).toBe(3600 * 16384);
    expect(parseVmStat("nothing")).toBeNull();
  });

  it("refuses to load a model that won't fit, and says what to close", async () => {
    await expect(checkRoom(config, "qwen3.5-9b", deps(2, [], ["Ollama is holding llama3.2 (2.0 GB): run “ollama stop llama3.2”"]))).rejects.toThrow(/Not enough free memory to load qwen3.5-9b.*ollama stop llama3.2/);
    await expect(checkRoom(config, "qwen3.5-9b", deps(6))).resolves.toBeUndefined();
  });

  it("counts a model llama-swap will swap out as free, and passes one already loaded", async () => {
    await expect(checkRoom(config, "qwen3.5-9b", deps(2.5, ["bonsai-8b"]))).resolves.toBeUndefined();
    await expect(checkRoom({ ...config, keepBothLoaded: true }, "qwen3.5-9b", deps(2.5, ["bonsai-8b"]))).rejects.toThrow(/Not enough free memory/);
    await expect(checkRoom(config, "qwen3.5-9b", deps(0.1, ["qwen3.5-9b"]))).resolves.toBeUndefined();
    await expect(checkRoom(config, "some-other-model", deps(0.1))).resolves.toBeUndefined();
  });
});

describe("setup I/O", () => {
  it("installs a program from a GitHub release into the bin folder", async () => {
    const dir = await tempDir();
    const src = path.join(dir, "src", "llama-swap_darwin_arm64");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "llama-swap"), "#!/bin/sh\necho hi\n");
    await writeFile(path.join(src, "README.md"), "docs");
    const archive = path.join(dir, "llama-swap_200_linux_amd64.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", path.join(dir, "src"), "."]);
    const body = await readFile(archive);
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify({ tag_name: "v200", assets: [{ name: "llama-swap_200_linux_amd64.tar.gz", browser_download_url: "https://dl/llama-swap.tar.gz" }] }));
      }
      return new Response(body);
    }) as typeof fetch;
    const bin = path.join(dir, "bin");
    const message = await installRelease(releaseTool("llama-swap", "linux", "x64")!, fakeFetch, bin);
    expect(message).toContain("mostlygeek/llama-swap v200");
    expect(urls).toEqual(["https://api.github.com/repos/mostlygeek/llama-swap/releases/latest", "https://dl/llama-swap.tar.gz"]);
    expect(existsSync(path.join(bin, "llama-swap"))).toBe(true);
    expect(existsSync(path.join(bin, "README.md"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(path.join(bin, "llama-swap")).mode & 0o111).toBeTruthy();
  });

  it("knows when a model is already downloaded, in either cache", async () => {
    const home = await tempDir();
    await mkdir(path.join(home, ".cache", "huggingface", "hub", "models--prism-ml--Ternary-Bonsai-8B-mlx-2bit"), { recursive: true });
    expect(modelCached("prism-ml/Ternary-Bonsai-8B-mlx-2bit", {}, home, "darwin")).toBe(true);
    expect(modelCached("mlx-community/Qwen3.5-9B-OptiQ-4bit", {}, home, "darwin")).toBe(false);
    const llamaCache = path.join(home, "AppData", "Local", "llama.cpp");
    await mkdir(llamaCache, { recursive: true });
    await writeFile(path.join(llamaCache, "unsloth_Qwen3.5-9B-GGUF_Qwen3.5-9B-Q4_K_M.gguf"), "");
    expect(modelCached("unsloth/Qwen3.5-9B-GGUF:Q4_K_M", {}, home, "win32")).toBe(true);
    expect(modelCached("unsloth/Qwen3.5-35B-A3B-GGUF:UD-Q4_K_XL", {}, home, "win32")).toBe(false);
  });

  it("finds the GGUF files and Bonsai's llama-server already on this computer, and picks Qwen IQ3_XXS + Bonsai", async () => {
    const home = await tempDir();
    const models = path.join(home, "Bonsai-demo", "models");
    await mkdir(path.join(models, "qwen3.5-9b"), { recursive: true });
    await mkdir(path.join(models, "ternary-gguf", "8B"), { recursive: true });
    await mkdir(path.join(home, "Bonsai-demo", "bin", "mac"), { recursive: true });
    for (const f of ["qwen3.5-9b/Qwen3.5-9B-UD-IQ2_M.gguf", "qwen3.5-9b/Qwen3.5-9B-UD-IQ3_XXS.gguf", "qwen3.5-9b/mmproj-F16.gguf", "ternary-gguf/8B/Ternary-Bonsai-8B-PQ2_0.gguf"]) await writeFile(path.join(models, f), "x");
    await writeFile(path.join(home, "Bonsai-demo", "bin", "mac", "llama-server"), "");
    const found = await findLocal(home);
    expect(found.models.map((m) => path.basename(m.path)).sort()).toEqual(["Qwen3.5-9B-UD-IQ2_M.gguf", "Qwen3.5-9B-UD-IQ3_XXS.gguf", "Ternary-Bonsai-8B-PQ2_0.gguf"]);
    expect(found.servers).toEqual([path.join(home, "Bonsai-demo", "bin", "mac", "llama-server")]);
    const picked = pickModels(found);
    expect(path.basename(picked.head!)).toBe("Qwen3.5-9B-UD-IQ3_XXS.gguf");
    expect(path.basename(picked.executor!)).toBe("Ternary-Bonsai-8B-PQ2_0.gguf");
    expect(modelCached(picked.head!, {}, home, "darwin")).toBe(true);
  });

  it("lists the old MLX downloads with their sizes, and Ollama's models as not deletable here", async () => {
    const home = await tempDir();
    const qwen = path.join(home, ".cache", "huggingface", "hub", "models--mlx-community--Qwen3.5-9B-OptiQ-4bit", "blobs");
    await mkdir(qwen, { recursive: true });
    await writeFile(path.join(qwen, "a"), Buffer.alloc(3000));
    await mkdir(path.join(home, ".ollama", "models"), { recursive: true });
    await writeFile(path.join(home, ".ollama", "models", "b"), Buffer.alloc(1000));
    const items = await storageItems(home, {});
    expect(items.map((i) => [i.id, i.bytes, i.deletable])).toEqual([
      ["mlx-qwen", 3000, true],
      ["ollama", 1000, false]
    ]);
  });
});
