import { describe, expect, it } from "vitest";
import { cleanTeamConfig, DEFAULT_TEAM, MODELS, pcBaseUrl, presetConfig, roleSettings } from "../src/main/team/config.js";
import { clearProbeCache, probeEndpoint, resolveRole } from "../src/main/team/endpoints.js";
import type { RoleEndpoint, TeamConfig } from "../src/shared/types.js";

/** A fake network: which servers answer, and with which models. */
function fakeFetch(up: Record<string, string[]>) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const base = Object.keys(up).find((b) => url.startsWith(b));
    if (!base) throw new Error("connect ECONNREFUSED");
    const models = up[base]!;
    const body = url.endsWith("/api/tags") ? { models: models.map((name) => ({ name })) } : { data: models.map((id) => ({ id })) };
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
}

describe("team config", () => {
  it("starts in single mode, so nothing changes until a team is chosen", () => {
    expect(cleanTeamConfig(undefined).mode).toBe("single");
    expect(cleanTeamConfig({}).engine).toBe("mimir");
  });

  it("keeps good values and replaces bad ones", () => {
    const cleaned = cleanTeamConfig({ mode: "team", engine: "nope", roles: { head: { primary: { provider: "bogus", model: "  ", baseUrl: "http://x:1" }, tier: "huge" } } });
    expect(cleaned.mode).toBe("team");
    expect(cleaned.engine).toBe("mimir");
    expect(cleaned.roles.head.primary).toEqual({ provider: DEFAULT_TEAM.roles.head.primary.provider, model: DEFAULT_TEAM.roles.head.primary.model, baseUrl: "http://x:1" });
    expect(cleaned.roles.head.tier).toBe("auto");
    expect(cleaned.roles.executor).toEqual(DEFAULT_TEAM.roles.executor);
  });

  it("turns a PC address into a server URL", () => {
    expect(pcBaseUrl("192.168.1.20")).toBe("http://192.168.1.20:8080");
    expect(pcBaseUrl("192.168.1.20:9000/")).toBe("http://192.168.1.20:9000");
    expect(pcBaseUrl("https://pc.tailnet:8443")).toBe("https://pc.tailnet:8443");
  });

  it("makes the three presets", () => {
    const mac = presetConfig("mac-mlx", DEFAULT_TEAM);
    expect(mac.mode).toBe("team");
    expect(mac.roles.head.primary.model).toBe(MODELS.macHead);
    expect(mac.roles.executor.primary.model).toBe(MODELS.macExecutor);
    expect(mac.roles.executor.tier).toBe("core");
    expect(mac.checkEachStep).toBe(false);

    const pc = presetConfig("windows-llamacpp", DEFAULT_TEAM);
    expect(pc.roles.head.primary.model).toBe(MODELS.pcHead);
    expect(pc.checkEachStep).toBe(true);

    const both = presetConfig("mac-with-pc", DEFAULT_TEAM, "192.168.1.20");
    expect(both.roles.head.primary).toEqual({ provider: "openai-compatible", model: MODELS.pcHead, baseUrl: "http://192.168.1.20:8080" });
    expect(both.roles.head.fallback?.model).toBe(MODELS.macHead);
    expect(both.roles.executor.fallback?.model).toBe(MODELS.macExecutor);
    expect(() => presetConfig("mac-with-pc", DEFAULT_TEAM, " ")).toThrow(/PC's address/);
  });

  it("lets the Checker borrow the Head's model", () => {
    const team: TeamConfig = { ...presetConfig("mac-mlx", DEFAULT_TEAM), checkerSameAsHead: true };
    expect(roleSettings(team, "checker")).toBe(team.roles.head);
    expect(roleSettings({ ...team, checkerSameAsHead: false }, "checker")).toBe(team.roles.checker);
  });
});

describe("team endpoints", () => {
  const team = presetConfig("mac-with-pc", DEFAULT_TEAM, "192.168.1.20");

  it("uses the PC when it answers", async () => {
    clearProbeCache();
    const status = await resolveRole(team, "head", fakeFetch({ "http://192.168.1.20:8080": [MODELS.pcHead], "http://127.0.0.1:8080": [MODELS.macHead] }));
    expect(status).toMatchObject({ using: "primary", reachable: true, endpoint: { model: MODELS.pcHead } });
  });

  it("falls back to this Mac when the PC is off", async () => {
    clearProbeCache();
    const status = await resolveRole(team, "executor", fakeFetch({ "http://127.0.0.1:8080": [MODELS.macHead, MODELS.macExecutor] }));
    expect(status).toMatchObject({ using: "fallback", reachable: true, endpoint: { model: MODELS.macExecutor } });
    expect(status.detail).toMatch(/using the fallback/);
  });

  it("says when neither answers", async () => {
    clearProbeCache();
    const status = await resolveRole(team, "head", fakeFetch({}));
    expect(status).toMatchObject({ using: "none", reachable: false });
    expect(status.detail).toMatch(/isn't answering/);
  });

  it("notices a server that doesn't have the model", async () => {
    clearProbeCache();
    const status = await resolveRole(presetConfig("mac-mlx", DEFAULT_TEAM), "head", fakeFetch({ "http://127.0.0.1:8080": ["something-else"] }));
    expect(status.reachable).toBe(true);
    expect(status.detail).toMatch(/doesn't list "qwen3.5-9b"/);
  });

  it("reads Ollama's and OpenAI-style model lists", async () => {
    clearProbeCache();
    const net = fakeFetch({ "http://localhost:11434": ["llama3.2:latest"], "http://127.0.0.1:8080": ["bonsai-8b"] });
    const ollama: RoleEndpoint = { provider: "ollama", model: "llama3.2:latest", baseUrl: null };
    expect((await probeEndpoint(ollama, net)).models).toEqual(["llama3.2:latest"]);
    expect((await probeEndpoint({ provider: "openai-compatible", model: "bonsai-8b", baseUrl: "127.0.0.1:8080" }, net)).models).toEqual(["bonsai-8b"]);
  });

  it("remembers an answer for a while instead of asking every turn", async () => {
    clearProbeCache();
    let calls = 0;
    const counting = (async (input: string | URL | Request) => { calls++; return fakeFetch({ "http://127.0.0.1:8080": ["m"] })(input); }) as typeof fetch;
    const ep: RoleEndpoint = { provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:8080" };
    await probeEndpoint(ep, counting);
    await probeEndpoint(ep, counting);
    expect(calls).toBe(1);
  });
});
