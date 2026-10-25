import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkEngine, spawnCommand } from "./common.js";

/**
 * Installing Hermes Agent from inside Mimir (Settings → Brain team, or BridgeDeck's settings): its
 * official installer without the browser and computer-use parts, then its ACP extra (what Mimir
 * talks to), then `hermes acp --check`. Honcho's plugin is added when Honcho is chosen. The found
 * command is saved as the Hermes command, so nothing has to be put on PATH by hand.
 */

const SITE = "https://hermes-agent.nousresearch.com";

export interface InstallStep {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
}

/** Where the installer puts the `hermes` command. */
export function hermesCandidates(platform = process.platform, home = os.homedir(), env = process.env): string[] {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(local, "hermes", "bin", "hermes.exe"), path.join(local, "hermes", "bin", "hermes.cmd"), path.join(home, ".local", "bin", "hermes.exe")];
  }
  return [path.join(home, ".local", "bin", "hermes"), "/opt/homebrew/bin/hermes", "/usr/local/bin/hermes"];
}

/** The Python inside Hermes's own environment, for adding its ACP extra. */
function hermesPython(platform: string, home: string): { python: string; dir: string } {
  const dir = path.join(home, ".hermes", "hermes-agent");
  const venv = platform === "win32" ? path.join(dir, "venv", "Scripts", "python.exe") : path.join(dir, "venv", "bin", "python");
  return { python: existsSync(venv) ? venv : platform === "win32" ? "python" : "python3", dir };
}

/** The steps, in order, for this computer. `hermes` is the command found after the installer. */
export function installSteps(opts: { platform?: string; home?: string; hermes: string; honcho: boolean }): InstallStep[] {
  const platform = opts.platform ?? process.platform, home = opts.home ?? os.homedir();
  const { python, dir } = hermesPython(platform, home);
  const install: InstallStep = platform === "win32"
    ? { label: "Installing Hermes", command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& ([scriptblock]::Create((irm ${SITE}/install.ps1))) -NonInteractive -SkipBrowser -SkipComputerUse`] }
    : { label: "Installing Hermes", command: "bash", args: ["-c", `curl -fsSL ${SITE}/install.sh | bash -s -- --non-interactive --skip-browser --skip-computer-use`] };
  return [
    install,
    { label: "Adding its ACP extra", command: python, args: ["-c", "import pm; pm.sync_venv(['acp'], explicit=True)"], cwd: dir },
    ...(opts.honcho ? [{ label: "Adding the Honcho plugin", command: opts.hermes, args: ["plugins", "install", "honcho"] }] : []),
    { label: "Checking Hermes", command: opts.hermes, args: ["acp", "--check"] }
  ];
}

export interface InstallState {
  running: boolean;
  /** null until it has finished. */
  ok: boolean | null;
  log: string[];
  /** The command found, when it worked. */
  command: string | null;
}

const MAX_LOG = 400;

function runStep(step: InstallStep, log: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnCommand(step.command, step.args, { cwd: step.cwd && existsSync(step.cwd) ? step.cwd : undefined, stdio: ["ignore", "pipe", "pipe"] });
    const lines = (d: Buffer) => d.toString().split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).forEach(log);
    child.stdout?.on("data", lines);
    child.stderr?.on("data", lines);
    child.on("error", (err) => { log(`Couldn't run ${step.command}: ${err.message}`); resolve(-1); });
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/** Runs one install at a time and keeps its log for whoever asks (the UI polls). */
export class HermesInstaller {
  state: InstallState = { running: false, ok: null, log: [], command: null };

  constructor(private deps: {
    run?: (step: InstallStep, log: (line: string) => void) => Promise<number>;
    find?: (configured: string | null) => Promise<string | null>;
    save: (command: string) => Promise<void>;
  }) {}

  private log(line: string) {
    this.state.log.push(line);
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
  }

  /** Starts the install (if one isn't running) and returns at once. */
  start(opts: { configured: string | null; honcho: boolean }): InstallState {
    if (this.state.running) return this.state;
    this.state = { running: true, ok: null, log: [], command: null };
    void this.install(opts).catch((err: unknown) => {
      this.log(err instanceof Error ? err.message : String(err));
      this.state.running = false;
      this.state.ok = false;
    });
    return this.state;
  }

  private async install(opts: { configured: string | null; honcho: boolean }) {
    const run = this.deps.run ?? runStep;
    const find = this.deps.find ?? findHermes;
    const [first] = installSteps({ hermes: "hermes", honcho: false });
    this.log(`— ${first!.label}`);
    if ((await run(first!, (l) => this.log(l))) !== 0) return this.finish(false, "The installer failed (above).");
    const command = await find(opts.configured);
    if (!command) return this.finish(false, "Installed, but the hermes command wasn't found. Set its path by hand.");
    const [acp, ...rest] = installSteps({ hermes: command, honcho: opts.honcho }).slice(1);
    // The ACP extra may already be in, so its failure isn't the end: the check at the end decides.
    this.log(`— ${acp!.label}`);
    await run(acp!, (l) => this.log(l));
    for (const step of rest) {
      this.log(`— ${step.label}`);
      if ((await run(step, (l) => this.log(l))) !== 0) return this.finish(false, `${step.label} failed (above).`);
    }
    await this.deps.save(command);
    this.state.command = command;
    this.finish(true, `Hermes is ready (${command}).`);
  }

  private finish(ok: boolean, line: string) {
    this.log(line);
    this.state.running = false;
    this.state.ok = ok;
  }
}

/** The Hermes command that answers `--version`: the one set in settings, on PATH, or where the
 * installer puts it. */
export async function findHermes(configured: string | null): Promise<string | null> {
  for (const c of [...(configured ? [configured] : []), "hermes", ...hermesCandidates().filter((p) => existsSync(p))]) {
    if ((await checkEngine("hermes", c)).ok) return c;
  }
  return null;
}
