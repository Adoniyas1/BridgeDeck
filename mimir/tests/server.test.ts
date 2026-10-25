import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";

describe("serving the renderer", () => {
  let rendererFile: (root: string, urlPath: string) => string | null;
  beforeAll(async () => {
    process.env.MIMIR_NO_AUTOSTART = "1";
    ({ rendererFile } = await import("../src/main/server.js"));
  });

  const root = path.resolve("/srv/mimir/dist/renderer");

  it("maps / to index.html and keeps other paths inside the renderer folder", () => {
    expect(rendererFile(root, "/")).toBe(path.join(root, "index.html"));
    expect(rendererFile(root, "/assets/app.js?v=1")).toBe(path.join(root, "assets", "app.js"));
  });

  it("refuses paths that leave it", () => {
    expect(rendererFile(root, "/../main/server.js")).toBeNull();
    expect(rendererFile(root, "/%2e%2e/%2e%2e/secret")).toBeNull();
    expect(rendererFile(root, "/%E0%A4%A")).toBeNull();
  });
});

describe("BridgeDeck's control channel", () => {
  it("takes only this run's token and only the settings channels", async () => {
    process.env.MIMIR_NO_AUTOSTART = "1";
    const { authorized, CONTROL_CHANNELS } = await import("../src/main/server.js");
    const { IPC } = await import("../src/shared/types.js");
    expect(authorized("Bearer abc123", "abc123")).toBe(true);
    expect(authorized("Bearer abc124", "abc123")).toBe(false);
    expect(authorized("abc123", "abc123")).toBe(false);
    expect(authorized(undefined, "abc123")).toBe(false);
    expect(CONTROL_CHANNELS.has(IPC.modelsDownload)).toBe(true);
    // Nothing that chats, runs code or edits Mimir itself.
    for (const ch of [IPC.chatSpeak, IPC.memorySet, IPC.pythonHostCall, IPC.auditRevert, IPC.chatgptSend]) expect(CONTROL_CHANNELS.has(ch)).toBe(false);
  });
});
