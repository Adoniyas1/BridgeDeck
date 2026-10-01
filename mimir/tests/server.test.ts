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
