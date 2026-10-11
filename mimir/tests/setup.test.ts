import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanSetupConfig, cmdPath, mergeSetupConfig, defaultSetup, localSwapUrl, pickAssets, releaseTool, swapYaml } from "../src/main/setup/plan.js";
import { installRelease, modelCached } from "../src/main/setup/index.js";

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
  it("writes llama-swap's config: MLX on the Mac, llama.cpp on the PC", () => {
    const mac = swapYaml(defaultSetup("mac"), "/Users/me/.local/bin/mlx_lm.server");
    expect(mac).toContain('"qwen3.5-9b":\n    cmd: "/Users/me/.local/bin/mlx_lm.server --model mlx-community/Qwen3.5-9B-OptiQ-4bit --host 127.0.0.1 --port ${PORT}"');
    expect(mac).toContain('"bonsai-8b":\n    cmd: "/Users/me/.local/bin/mlx_lm.server --model prism-ml/Ternary-Bonsai-8B-mlx-2bit');
    expect(mac).toContain('checkEndpoint: "/v1/models"');
    expect(mac).not.toContain("groups:");

    const pc = swapYaml({ ...defaultSetup("pc"), keepBothLoaded: true }, "C:\\Users\\Jo Smith\\.mimir\\bin\\llama.cpp\\llama-server.exe");
    expect(pc).toContain(`cmd: "'C:/Users/Jo Smith/.mimir/bin/llama.cpp/llama-server.exe' -hf unsloth/Qwen3.5-35B-A3B-GGUF:UD-Q4_K_XL --host 127.0.0.1 --port \${PORT} -c 32768 -ngl 99 --n-cpu-moe 24 --jinja"`);
    expect(pc).toContain('groups:\n  "team":\n    swap: false\n    exclusive: true\n    members:\n      - "qwen3.5-35b-a3b"\n      - "qwen3.5-9b"');
    expect(cmdPath("/usr/bin/llama-server")).toBe("/usr/bin/llama-server");
  });

  it("cleans the settings and starts each computer from its own models", () => {
    expect(cleanSetupConfig({}, "darwin")).toEqual(defaultSetup("mac"));
    expect(cleanSetupConfig({}, "win32")).toMatchObject({ computer: "pc", listen: "0.0.0.0:8080" });
    const messy = cleanSetupConfig({ computer: "mac", listen: "nope", models: { head: { name: "x y", source: "not a repo; rm -rf /", args: "a\nb" } } }, "darwin");
    expect(messy.listen).toBe("127.0.0.1:8080");
    expect(messy.models.head).toEqual({ ...defaultSetup("mac").models.head, args: "a b" });
    // A Mac config read on a PC (no computer saved) gets the PC's models.
    expect(cleanSetupConfig({ models: defaultSetup("mac").models }, "win32").models.head.source).toContain("35B");
    expect(localSwapUrl(defaultSetup("pc"))).toBe("http://127.0.0.1:8080");

    const pc = { ...defaultSetup("pc"), autostart: true };
    const mac = mergeSetupConfig(pc, { computer: "mac", listen: "127.0.0.1:18090" });
    expect(mac).toEqual({ ...defaultSetup("mac"), autostart: true, listen: "127.0.0.1:18090" });
    const edited = mergeSetupConfig(mac, { models: { ...mac.models, executor: { ...mac.models.executor, source: "me/bonsai-3bit" } } });
    expect(edited.models.executor.source).toBe("me/bonsai-3bit");
    expect(edited.models.head).toEqual(mac.models.head);
  });

  it("picks the right release files, with a CUDA runtime that matches the build", () => {
    const names = (list: string[]) => list.map((name) => ({ name }));
    const swapMac = releaseTool("llama-swap", "darwin", "arm64")!;
    expect(pickAssets(swapMac, names(["llama-swap_200_linux_amd64.tar.gz", "llama-swap_200_darwin_arm64.tar.gz"])).map((a) => a.name)).toEqual(["llama-swap_200_darwin_arm64.tar.gz"]);
    expect(pickAssets(releaseTool("llama-swap", "win32", "x64")!, names(["llama-swap_200_windows_amd64.zip"]))).toHaveLength(1);
    expect(pickAssets(releaseTool("uv", "darwin", "arm64")!, names(["uv-x86_64-apple-darwin.tar.gz", "uv-aarch64-apple-darwin.tar.gz"]))[0]!.name).toBe("uv-aarch64-apple-darwin.tar.gz");

    const cpp = releaseTool("llama.cpp", "win32", "x64")!;
    const files = names([
      "llama-b7000-bin-win-cpu-x64.zip",
      "llama-b7000-bin-win-cuda-13.1-x64.zip",
      "cudart-llama-bin-win-cuda-13.1-x64.zip",
      "llama-b7000-bin-win-cuda-12.4-x64.zip",
      "cudart-llama-bin-win-cuda-12.4-x64.zip"
    ]);
    expect(pickAssets(cpp, files).map((a) => a.name)).toEqual(["llama-b7000-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"]);
    expect(pickAssets(cpp, names(["llama-b7000-bin-win-cuda-13.1-x64.zip", "cudart-llama-bin-win-cuda-13.1-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip"])).map((a) => a.name)).toEqual([
      "llama-b7000-bin-win-cuda-13.1-x64.zip",
      "cudart-llama-bin-win-cuda-13.1-x64.zip"
    ]);
    expect(() => pickAssets(cpp, names(["llama-b7000-bin-win-cpu-x64.zip"]))).toThrow(/no file for this computer/);
    expect(releaseTool("llama.cpp", "darwin", "arm64")).toBeNull();
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
});
