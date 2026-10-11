import { describe, it, expect, afterEach, vi } from "vitest";
import { normalizeBaseUrl } from "../src/main/brain/baseUrl.js";
import { OllamaProvider, listOllamaModels } from "../src/main/brain/ollamaProvider.js";

describe("normalizeBaseUrl", () => {
  it("adds http:// to a bare host:port", () => {
    expect(normalizeBaseUrl("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(normalizeBaseUrl("localhost:11434/")).toBe("http://localhost:11434");
  });

  it("keeps an explicit scheme and strips trailing slashes and whitespace", () => {
    expect(normalizeBaseUrl("  https://my-vps:8080// ")).toBe("https://my-vps:8080");
    expect(normalizeBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
  });

  it("returns null for blank input", () => {
    expect(normalizeBaseUrl(null)).toBeNull();
    expect(normalizeBaseUrl("   ")).toBeNull();
  });
});

describe("Ollama with a scheme-less base URL", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("chat() requests http://host:port/api/chat", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("stop");
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaProvider("llama3.2:latest", "127.0.0.1:11434");
    for await (const _ of provider.chat([{ role: "user", content: "hi" }], [], { system: "s" } as never)) {
      // drain
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/chat");
  });

  it("listOllamaModels() requests http://host:port/api/tags", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: "llama3.2:latest" }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await listOllamaModels("127.0.0.1:11434")).toEqual(["llama3.2:latest"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/tags");
  });
});
