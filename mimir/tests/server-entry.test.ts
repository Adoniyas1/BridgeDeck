import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Runs the real launcher with a fake home and a fake build that just reports which file ran. When it
// falls back to this checkout's own build, MIMIR_NO_AUTOSTART keeps that real server from starting.
async function launch(home: string, failures: number, activeDir: string | null) {
  const mimirHome = path.join(home, ".mimir");
  await mkdir(mimirHome, { recursive: true });
  await writeFile(path.join(mimirHome, "boot-attempts.json"), JSON.stringify({ consecutiveFailures: failures }));
  await writeFile(path.join(mimirHome, "active.json"), JSON.stringify({ activeDir }));
  const result = spawnSync(process.execPath, [path.resolve("server-entry.mjs")], { env: { ...process.env, HOME: home, USERPROFILE: home, MIMIR_NO_AUTOSTART: "1" }, encoding: "utf-8", timeout: 15_000 });
  const attempts = JSON.parse(await readFile(path.join(mimirHome, "boot-attempts.json"), "utf-8")) as { consecutiveFailures: number };
  return { output: result.stdout + result.stderr, attempts: attempts.consecutiveFailures };
}

async function fakeBuild(dir: string, label: string) {
  await mkdir(path.join(dir, "dist", "main"), { recursive: true });
  await writeFile(path.join(dir, "dist", "main", "server.js"), `console.log("RAN ${label}");\n`);
}

describe("server-entry.mjs", () => {
  it("runs the self-edited build and counts the attempt", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mimir-entry-"));
    const workspace = path.join(home, "workspace");
    await fakeBuild(workspace, "workspace");
    const { output, attempts } = await launch(home, 0, workspace);
    expect(output).toContain("RAN workspace");
    expect(attempts).toBe(1);
  });

  it("falls back to the original build after three failed starts", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "mimir-entry-"));
    const workspace = path.join(home, "workspace");
    await fakeBuild(workspace, "workspace");
    const { output, attempts } = await launch(home, 3, workspace);
    expect(output).toContain("falling back to the original install");
    expect(output).not.toContain("RAN workspace");
    expect(attempts).toBe(0);
  });
});
