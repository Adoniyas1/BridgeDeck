import { describe, expect, it } from "vitest";
import { contextOf, runAiChecks, type CheckInput } from "../src/main/health/aiCheck.js";
import { DEFAULT_TEAM } from "../src/main/team/config.js";
import { contextArg, defaultSetup, withContext } from "../src/main/setup/plan.js";
import type { BrainConfig } from "../src/shared/types.js";

const brain: BrainConfig = { provider: "ollama", model: "llama3.2:3b", baseUrl: null, hasApiKey: false, autoApproveCoreEdits: false, effort: "medium", webSearchEnabled: false };

function input(patch: Partial<CheckInput> = {}): CheckInput {
  return {
    team: { ...structuredClone(DEFAULT_TEAM), mode: "single", engine: "mimir" },
    brain,
    setup: defaultSetup("mac"),
    roles: [],
    brainServer: { reachable: true, models: ["llama3.2:3b"], detail: "http://localhost:11434 is up" },
    engine: null,
    agentModel: null,
    honchoKey: false,
    bridgedeck: { reachable: true, vault: true },
    freeDiskBytes: 100 * 1024 ** 3,
    ...patch
  };
}

/** A server that answers Ollama's /api/show and llama.cpp's /props. */
const server = (ctx: { ollama?: number; llama?: number }) =>
  (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/api/show") && ctx.ollama) return Response.json({ model_info: { "llama.context_length": ctx.ollama } });
    if (u.endsWith("/props") && ctx.llama) return Response.json({ default_generation_settings: { n_ctx: ctx.llama } });
    return new Response("", { status: 404 });
  }) as typeof fetch;

describe("Test my AI setup", () => {
  it("says it's all fine when it is", async () => {
    const checks = await runAiChecks(input());
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok", "ok"]);
    expect(checks[0]!.detail).toMatch(/one model: llama3\.2:3b \(Ollama\)/);
  });

  it("says Ollama is off, or doesn't have the model, and what to do", async () => {
    const off = await runAiChecks(input({ brainServer: { reachable: false, models: [], detail: "http://localhost:11434 isn't answering" } }));
    expect(off[1]).toMatchObject({ label: "Ollama", status: "fail" });
    expect(off[1]!.fix).toMatch(/ollama serve/);
    const missing = await runAiChecks(input({ brainServer: { reachable: true, models: ["qwen3:8b"], detail: "up" } }));
    expect(missing[1]!.fix).toMatch(/ollama pull llama3\.2:3b/);
  });

  it("checks Hermes: installed, and given enough context", async () => {
    const team = { ...structuredClone(DEFAULT_TEAM), mode: "team" as const, engine: "hermes" as const, engineModels: "team" as const };
    const small = await runAiChecks(input({
      team, roles: [], engine: { ok: true, detail: "Installed" },
      agentModel: { baseUrl: "http://127.0.0.1:8080", model: "bonsai-2-27b" },
      fetchImpl: server({ llama: 16384 })
    }));
    const ctx = small.find((c) => c.label === "Context for Hermes")!;
    expect(ctx.status).toBe("fail");
    expect(ctx.detail).toMatch(/16K tokens; Hermes needs 64K/);
    const ollama = await runAiChecks(input({ team, engine: { ok: true, detail: "Installed" }, agentModel: { baseUrl: "http://localhost:11434", model: "llama3.2:3b", ollama: true }, fetchImpl: server({ ollama: 131072 }) }));
    expect(ollama.find((c) => c.label === "Context for Hermes")!.status).toBe("ok");
    const missing = await runAiChecks(input({ team, engine: { ok: false, detail: "Hermes isn't installed" }, agentModel: null }));
    expect(missing.find((c) => c.label === "Hermes")!.fix).toMatch(/Install Hermes/);
  });

  it("flags a missing model file, BridgeDeck out of reach and a nearly full disk", async () => {
    const setup = defaultSetup("pc");
    setup.models.head = { ...setup.models.head, source: "/models/gone.gguf" };
    const checks = await runAiChecks(input({ setup, exists: () => false, bridgedeck: { reachable: false, vault: false }, freeDiskBytes: 1024 ** 3 }));
    expect(checks.find((c) => c.label === "Head's model file")?.status).toBe("fail");
    expect(checks.find((c) => c.label === "BridgeDeck")?.status).toBe("fail");
    expect(checks.find((c) => c.label === "Disk space")?.status).toBe("fail");
  });

  it("reads a model's context from Ollama, llama-swap or llama.cpp", async () => {
    expect(await contextOf({ baseUrl: "http://localhost:11434", model: "m", ollama: true }, server({ ollama: 131072 }))).toBe(131072);
    expect(await contextOf({ baseUrl: "http://127.0.0.1:8080", model: "m" }, server({ llama: 8192 }))).toBe(8192);
    expect(await contextOf({ baseUrl: "http://127.0.0.1:8080", model: "m" }, server({}))).toBeNull();
  });
});

describe("giving a model more context", () => {
  it("raises -c to the minimum, adds it when missing, and leaves enough alone", () => {
    expect(withContext("-c 16384 -ngl 99 -fa on", 65536)).toBe("-c 65536 -ngl 99 -fa on");
    expect(withContext("-ngl 99 --ctx-size 8192", 65536)).toBe("-ngl 99 --ctx-size 65536");
    expect(withContext("-ngl 99", 65536)).toBe("-c 65536 -ngl 99");
    expect(withContext("-c 131072 -ngl 99", 65536)).toBe("-c 131072 -ngl 99");
    expect(contextArg("-ngl 99 -c 4096")).toBe(4096);
  });
});

describe("the chosen agent answering", () => {
  const hermes = { ...structuredClone(DEFAULT_TEAM), mode: "single" as const, engine: "hermes" as const, engineModels: "own" as const };
  const found = { ok: true, detail: "Installed (/usr/local/bin/hermes)" };
  const row = (checks: Awaited<ReturnType<typeof runAiChecks>>) => checks.find((c) => c.label === "Hermes answers");

  it("passes when it answers, and says how fast", async () => {
    const r = row(await runAiChecks(input({ team: hermes, engine: found, engineReply: { ok: true, ms: 2400, message: "ready", borrowed: false } })));
    expect(r).toMatchObject({ status: "ok", detail: "It answered a test message in 2.4 s." });
  });

  it("warns when Hermes only answered with the team's model", async () => {
    expect(row(await runAiChecks(input({ team: hermes, engine: found, engineReply: { ok: true, ms: 900, message: "ready", borrowed: true } })))?.status).toBe("warn");
  });

  it("fails with the reason, the fix, and what happens meanwhile", async () => {
    const r = row(await runAiChecks(input({ team: hermes, engine: found, engineReply: { ok: false, ms: 300, message: "Hermes: You are not connected to any AI provider yet.", borrowed: false } })));
    expect(r?.status).toBe("fail");
    expect(r?.detail).toMatch(/no AI provider/);
    expect(r?.fix).toMatch(/hermes model.*Mimir answers with its own model/s);
  });
});
