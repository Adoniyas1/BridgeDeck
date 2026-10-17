import { afterEach, describe, expect, it, vi } from "vitest";

describe("crash log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stops quietly when BridgeDeck (reading its output) is gone, instead of logging a crash", async () => {
    const { installCrashLog } = await import("../src/main/logs/crashLog.js");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    installCrashLog();
    process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(exit).toHaveBeenCalledWith(0);
  });
});
