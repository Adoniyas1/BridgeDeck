import { describe, expect, it } from "vitest";
import { ggufBlockCount, guessLayers, layerSplit, parseNvidiaSmi, parseRegistryGpus } from "../src/main/setup/gpu.js";
import { argsForShare, cleanSetupConfig, defaultSetup, swapYaml } from "../src/main/setup/plan.js";

const MB = 1024 ** 2;

/** A GGUF header with a few metadata entries, as llama.cpp writes it. */
function gguf(entries: Array<[string, "string" | "u32" | "strings", string | number | string[]]>): Buffer {
  const parts: Buffer[] = [Buffer.from("GGUF", "latin1"), u32(3), u64(0), u64(entries.length)];
  for (const [key, type, value] of entries) {
    parts.push(str(key));
    if (type === "string") parts.push(u32(8), str(value as string));
    else if (type === "u32") parts.push(u32(4), u32(value as number));
    else parts.push(u32(9), u32(8), u64((value as string[]).length), ...(value as string[]).map(str));
  }
  return Buffer.concat(parts);
}
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n: number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function str(s: string) { const v = Buffer.from(s, "utf8"); return Buffer.concat([u64(v.length), v]); }

describe("graphics card memory", () => {
  it("reads nvidia-smi: name, total, used and free VRAM", () => {
    const [gpu] = parseNvidiaSmi("NVIDIA GeForce RTX 4070 Ti, 12282, 1024, 11000\n");
    expect(gpu).toMatchObject({ name: "NVIDIA GeForce RTX 4070 Ti", vendor: "nvidia", totalBytes: 12282 * MB, usedBytes: 1024 * MB, freeBytes: 11000 * MB, shared: false });
    expect(parseNvidiaSmi("")).toEqual([]);
    expect(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")).toEqual([]);
  });

  it("reads a card's full memory from the registry (past WMI's 4 GB limit)", () => {
    const gpus = parseRegistryGpus("AMD Radeon RX 7800 XT|17163091968\r\nMicrosoft Basic Display Adapter|\r\n");
    expect(gpus).toEqual([{ name: "AMD Radeon RX 7800 XT", vendor: "amd", totalBytes: 17163091968, usedBytes: null, freeBytes: null, shared: false }]);
  });
});

describe("splitting a model between the GPU and the CPU", () => {
  it("reads the layer count from a GGUF file's header, past long arrays", () => {
    const buf = gguf([["general.architecture", "string", "qwen3"], ["tokenizer.ggml.tokens", "strings", ["a", "bb", "ccc"]], ["qwen3.block_count", "u32", 36]]);
    expect(ggufBlockCount(buf)).toBe(36);
    expect(ggufBlockCount(Buffer.from("not a gguf file at all, no"))).toBeNull();
    expect(ggufBlockCount(gguf([["general.architecture", "string", "x"]]))).toBeNull();
  });

  it("guesses typical layer counts from the model's name", () => {
    expect(guessLayers("prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0")).toBe(62);
    expect(guessLayers("unsloth/Qwen3.5-9B-GGUF:UD-IQ3_XXS")).toBe(36);
  });

  it("puts 80 % of the layers on the GPU and the rest on the CPU", () => {
    expect(layerSplit("x/y-9B:Q4", 80, () => 36)).toEqual({ layers: 36, onGpu: 29, fromFile: true });
    expect(layerSplit("x/y-9B:Q4", 100, () => null)).toEqual({ layers: 36, onGpu: 36, fromFile: false });
    expect(layerSplit("x/y-9B:Q4", 0, () => 36).onGpu).toBe(0);
  });

  it("sets -ngl in a model's arguments, unless they already ask for fewer layers", () => {
    const split = { layers: 36, onGpu: 29, fromFile: true };
    expect(argsForShare("-c 16384 -ngl 99 -fa on", 80, split)).toBe("-c 16384 -ngl 29 -fa on");
    expect(argsForShare("-c 8192", 80, split)).toBe("-c 8192 -ngl 29");
    expect(argsForShare("--n-gpu-layers=99 -c 1", 80, split)).toBe("-ngl 29 -c 1");
    expect(argsForShare("-ngl 10", 80, split)).toBe("-ngl 10");
    expect(argsForShare("-ngl 99", 100, split)).toBe("-ngl 99");
  });

  it("writes the split into the llama-swap config; the PC keeps 20 % on the CPU by default", () => {
    const pc = defaultSetup("pc");
    expect(pc.gpuShare).toBe(80);
    expect(defaultSetup("mac").gpuShare).toBe(100);
    const yaml = swapYaml(pc, "llama-server", { head: { layers: 62, onGpu: 50, fromFile: false } });
    expect(yaml).toContain("-ngl 50 -fa on");
    expect(yaml.match(/-ngl 99/g)).toHaveLength(2); // executor and checker: no split given
    expect(cleanSetupConfig({ ...pc, gpuShare: 83 }).gpuShare).toBe(85);
    expect(cleanSetupConfig({ ...pc, gpuShare: "lots" }).gpuShare).toBe(80);
    expect(cleanSetupConfig({ ...pc, gpuShare: 400 }).gpuShare).toBe(100);
  });
});

describe("Mimir's crash log", () => {
  it("writes crashes with their stack, indented under a timestamp", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { recordCrash } = await import("../src/main/logs/crashLog.js");
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "crash-")), "logs", "crash.log");
    recordCrash("crash", new Error("boom"), file);
    recordCrash("error (unhandled promise)", "nope", file);
    const text = await readFile(file, "utf8");
    expect(text).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] crash: Error: boom\n {4}at /);
    expect(text).toContain("] error (unhandled promise): nope\n");
  });
});

describe("expert models and easing off under load", () => {
  it("puts an expert model's experts in RAM instead of whole layers", async () => {
    const { isMoe } = await import("../src/main/setup/plan.js");
    expect(isMoe("unsloth/Qwen3.5-35B-A3B-GGUF:UD-Q4_K_XL")).toBe(true);
    expect(isMoe("prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0")).toBe(false);
    const split = { layers: 48, onGpu: 38, fromFile: true };
    expect(argsForShare("-c 16384 -ngl 99", 80, split, true)).toBe("-c 16384 -ngl 99 --n-cpu-moe 10");
    expect(argsForShare("-ngl 99 --n-cpu-moe 20", 80, split, true)).toBe("-ngl 99 --n-cpu-moe 20");
    expect(argsForShare("-ngl 99 --n-cpu-moe 4", 80, split, true)).toBe("-ngl 99 --n-cpu-moe 10");
  });

  it("eases off 10 points at a time under pressure, not below 40 %", async () => {
    const { lowerShare, underPressure, modelCallStarted, modelCallEnded, modelIdleFor } = await import("../src/main/setup/adaptive.js");
    expect(underPressure({ vramPercent: 97, ramPercent: 50, lagMs: 0 })).toBe("graphics memory 97% full");
    expect(underPressure({ vramPercent: null, ramPercent: 92, lagMs: 0 })).toBe("RAM 92% full");
    expect(underPressure({ vramPercent: 60, ramPercent: 60, lagMs: 2000 })).toBe("Mimir stalled for 2.0 s");
    expect(underPressure({ vramPercent: 60, ramPercent: 60, lagMs: 100 })).toBeNull();
    expect([lowerShare(80), lowerShare(45), lowerShare(40)]).toEqual([70, 40, null]);
    modelCallStarted();
    expect(modelIdleFor()).toBe(0);
    modelCallEnded();
    expect(modelIdleFor(Date.now() + 11_000)).toBeGreaterThan(10_000);
  });

  it("auto-tune keeps the fastest GPU share that fits, preferring less GPU when it's about as fast", async () => {
    const { pickShare, keepTuning, tokensPerSecond } = await import("../src/main/setup/adaptive.js");
    expect(tokensPerSecond({ timings: { predicted_per_second: 31.5 } }, 1000)).toBe(31.5);
    expect(tokensPerSecond({ usage: { completion_tokens: 50 } }, 2000)).toBe(25);
    expect(tokensPerSecond({}, 1000)).toBeNull();
    const results = [
      { share: 100, tokensPerSecond: 40, vramPercent: 97 }, // too full
      { share: 90, tokensPerSecond: 30, vramPercent: 88 },
      { share: 80, tokensPerSecond: 29, vramPercent: 80 }, // within 5% of 30: less VRAM, keep this
      { share: 70, tokensPerSecond: 20, vramPercent: 72 },
      { share: 60, tokensPerSecond: null, vramPercent: null, error: "didn't load" }
    ];
    expect(pickShare(results)?.share).toBe(80);
    expect(pickShare([{ share: 100, tokensPerSecond: null, vramPercent: null, error: "x" }])).toBeNull();
    expect(keepTuning(results.slice(0, 3))).toBe(true);
    expect(keepTuning([...results.slice(0, 3), { share: 70, tokensPerSecond: 15, vramPercent: 70 }])).toBe(false);
  });
});
