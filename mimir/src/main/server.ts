/**
 * Mimir's main process without Electron. BridgeDeck starts this (through the
 * immutable server-entry.mjs) and shows the UI in one of its tabs: this
 * process serves the built renderer over HTTP on 127.0.0.1 and talks to it
 * over a WebSocket, carrying the same channels Electron's IPC used (see
 * IPC in shared/types.ts and the renderer's bridge.ts).
 *
 * Stdout markers BridgeDeck reads:
 *   MIMIR_LISTENING {"port":…,"token":…}   the UI can connect
 *   MIMIR_HEALTHY                          boot succeeded (resets the crash-loop counter)
 *   MIMIR_NOTIFY {"title":…,"body":…}      show a desktop notification
 * Exit code 75 asks BridgeDeck to start it again at once (a self-edit wants
 * the new build to run).
 */
import http from "node:http";
import { installCrashLog, recordCrash } from "./logs/crashLog.js";
import { pruneLogs } from "./logs/turnLog.js";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { bootstrapWorkspace, defaultAuditFilePath, defaultWorkspaceRoot } from "./self-edit/workspace.js";
import { AgentSession } from "./agent/session.js";
import { reportHealthy } from "./health.js";
import { IPC } from "../shared/types.js";
import type {
  Attachment,
  MemoryFiles,
  MimirChat,
  MimirChatSummary,
  BrainConfig,
  BrainProviderKind,
  BuiltInCapability,
  PromptModuleInfo,
  McpPreset,
  McpServerStatus,
  RoleEndpoint,
  RoleStatus,
  TeamConfig,
  SetupConfig,
  TeamPreset,
  PersonaConfig,
  ProjectFileCorpusEntry,
  PythonRunResult,
  SemanticSearchHit,
  SkillSummary,
  VoiceConfig
} from "../shared/types.js";
import { loadBrainConfig, saveBrainConfig, setBrainApiKey } from "./brain/config.js";
import { listOllamaModels } from "./brain/ollamaProvider.js";
import { loadVoiceConfig, saveVoiceConfig, setElevenLabsKey, setPicovoiceKey } from "./voice/config.js";
import { startWakeWordListener, type WakeWordHandle } from "./voice/wake.js";
import { speak } from "./voice/tts.js";
import { loadPersonaConfig, savePersonaConfig } from "./persona/config.js";
import { startHeartbeatScheduler, stopHeartbeatScheduler } from "./persona/heartbeat.js";
import { startDeadlineNotifier, stopDeadlineNotifier } from "./persona/deadlines.js";
import { defaultProjectsRoot } from "./projects/paths.js";
import { defaultSkillsRoot } from "./skills/paths.js";
import { listSkillSummaries, verifySkillNow } from "./skills/tools.js";
import { listBuiltInCapabilities, listPromptModules } from "./skills/builtins.js";
import { loadMcpConfig, mcpPresets, saveMcpConfig, type McpConfig } from "./mcp/config.js";
import { mcpManager } from "./mcp/manager.js";
import { loadCodingConfig, saveCodingConfig, type CodingConfig } from "./coding/config.js";
import { applyTeamPreset, loadTeamConfig, saveTeamConfig, TEAM_PRESETS } from "./team/config.js";
import { clearProbeCache, probeEndpoint, teamStatus } from "./team/endpoints.js";
import { checkEngine } from "./engines/common.js";
import { HONCHO_KEY } from "./engines/index.js";
import { setSecret } from "./config/keychain.js";
import { loadObsidianConfig, saveObsidianConfig } from "./persona/obsidian.js";
import { jarvisBrief } from "./jarvis/brief.js";
import { autostartSwap, makeHeadHermesReady, startLoadWatch, runSetupStep, saveSetupConfig, setupView, swap, syncTeamWithSetup } from "./setup/index.js";
import { buildHostCapabilityDispatch, isCapabilityDeclaredForRun } from "./compute/hostCapabilities.js";
import type { UiWindow } from "./uiChannel.js";
import { deleteMimirChat, historyFromChat, listMimirChats, readMimirChat, writeMimirChat } from "./chats/store.js";
import { readMemoryFiles, writeMemoryFiles } from "./persona/memoryFiles.js";
import { SelfEditTransaction } from "./self-edit/transaction.js";
import { loadNaturalVoice } from "./voice/natural.js";
import { bridgeDeckFromEnv } from "./bridgedeck/client.js";
import { findHermes, HermesInstaller } from "./engines/hermesInstall.js";
import { downloads, libraryView, repoQuants, useModel } from "./models/index.js";
import { checkAi } from "./health/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The original install (set by server-entry.mjs): workspace seed and resources stay there even
 * when a self-edited build from the workspace is the one running. */
const APP_ROOT = process.env.MIMIR_APP_ROOT || path.resolve(__dirname, "..", "..");
const RESOURCES_DIR = path.join(APP_ROOT, "resources");
/** This build's own renderer (dist/main/server.js -> dist/renderer). */
const RENDERER_DIR = path.resolve(__dirname, "..", "renderer");
const RELAUNCH_EXIT_CODE = 75;

/** Where the Electron build kept its data, so an existing workspace and audit log carry over. */
function legacyElectronUserData(): string {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "mimir");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "mimir");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "mimir");
}

function resolveUserData(): string {
  if (process.env.MIMIR_USER_DATA) return process.env.MIMIR_USER_DATA;
  const legacy = legacyElectronUserData();
  if (existsSync(defaultWorkspaceRoot(legacy))) return legacy;
  return path.join(os.homedir(), ".mimir", "app");
}

const userData = resolveUserData();
const workspaceRoot = defaultWorkspaceRoot(userData);
const auditFilePath = defaultAuditFilePath(userData);
const token = process.env.MIMIR_TOKEN || randomBytes(24).toString("hex");
const bootId = randomUUID();

// --- Connected UIs -------------------------------------------------------

type Outgoing = { t: "hello"; bootId: string } | { t: "event"; ch: string; args: unknown[] } | { t: "result"; id: number; ok: boolean; value?: unknown; error?: string };

const clients = new Set<WebSocket>();
/** The most recently connected UI runs Python and embeddings for the agent. */
let primary: WebSocket | null = null;

function post(socket: WebSocket, message: Outgoing): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(ch: string, ...args: unknown[]): void {
  for (const socket of clients) post(socket, { t: "event", ch, args });
}

const ui: UiWindow = { webContents: { send: broadcast } };

function sendToPrimary(ch: string, ...args: unknown[]): boolean {
  if (!primary || primary.readyState !== primary.OPEN) return false;
  post(primary, { t: "event", ch, args });
  return true;
}

// --- Work the UI does for the agent (Python sandbox, embeddings) ----------

const pendingPythonRequests = new Map<string, (result: PythonRunResult) => void>();
// See the long note in the Electron version: covers the 20 s run timer plus the host-call budget.
const PYTHON_BRIDGE_TIMEOUT_MS = 85_000;
const hostCapabilityDispatch = buildHostCapabilityDispatch();

function runPythonInRenderer(code: string, args?: Record<string, unknown>, capabilities?: string[]): Promise<PythonRunResult> {
  return new Promise((resolve) => {
    const id = randomUUID();
    pendingPythonRequests.set(id, resolve);
    if (!sendToPrimary(IPC.pythonRunRequest, { id, code, args, capabilities })) {
      pendingPythonRequests.delete(id);
      resolve({ stdout: "", result: null, error: "Open the Mimir tab in BridgeDeck to run Python." });
      return;
    }
    setTimeout(() => {
      if (!pendingPythonRequests.delete(id)) return;
      resolve({ stdout: "", result: null, error: "No response from the Mimir tab (was it closed or reloaded?)." });
    }, PYTHON_BRIDGE_TIMEOUT_MS);
  });
}

const pendingSemanticSearchRequests = new Map<string, (hits: SemanticSearchHit[]) => void>();
const SEMANTIC_SEARCH_TIMEOUT_MS = 45_000; // first use downloads a small embedding model

function runSemanticSearchInRenderer(query: string, corpus: ProjectFileCorpusEntry[], topK: number): Promise<SemanticSearchHit[]> {
  return new Promise((resolve) => {
    const id = randomUUID();
    pendingSemanticSearchRequests.set(id, resolve);
    if (!sendToPrimary(IPC.semanticSearchRequest, { id, query, topK, corpus })) {
      pendingSemanticSearchRequests.delete(id);
      resolve([]);
      return;
    }
    setTimeout(() => {
      if (!pendingSemanticSearchRequests.delete(id)) return;
      resolve([]);
    }, SEMANTIC_SEARCH_TIMEOUT_MS);
  });
}

// --- Session and voice ---------------------------------------------------

let session: AgentSession | null = null;
const hermes = new HermesInstaller({
  save: async (command) => {
    const team = await loadTeamConfig();
    await saveTeamConfig({ engineCommands: { ...team.engineCommands, hermes: command } });
  }
});
let wakeHandle: WakeWordHandle | null = null;

async function startWake(): Promise<void> {
  if (wakeHandle) return;
  wakeHandle = await startWakeWordListener(RESOURCES_DIR, () => broadcast(IPC.voiceWakeTriggered));
}

function stopWake(): void {
  wakeHandle?.stop();
  wakeHandle = null;
}

/** Opens a folder in Finder / Explorer / the file manager. */
function openPath(target: string): Promise<{ ok: boolean; error?: string }> {
  const [command, args] =
    process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["explorer", [target]] : ["xdg-open", [target]];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", (error) => resolve({ ok: false, error: error.message }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

async function openFolder(root: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await mkdir(root, { recursive: true });
    return await openPath(root);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type Handler = (...args: never[]) => unknown;

/** Request/reply channels (Electron's ipcMain.handle). */
const invokeHandlers: Record<string, Handler> = {
  [IPC.chatSpeak]: async (text: string): Promise<void> => {
    const cfg = await loadVoiceConfig();
    broadcast(IPC.faceState, "speaking");
    try {
      await speak(text, { provider: cfg.ttsProvider, voiceId: cfg.elevenLabsVoiceId, systemVoice: cfg.systemVoice, naturalVoice: cfg.naturalVoice });
    } catch (err) {
      console.warn("[mimir] TTS failed:", err instanceof Error ? err.message : err);
    } finally {
      broadcast(IPC.faceState, "idle");
    }
  },
  [IPC.brainGetConfig]: (): Promise<BrainConfig> => loadBrainConfig(),
  [IPC.brainSetConfig]: (patch: Partial<Omit<BrainConfig, "hasApiKey">>): Promise<BrainConfig> => saveBrainConfig(patch),
  [IPC.brainSetApiKey]: async (provider: BrainProviderKind, key: string): Promise<void> => {
    await setBrainApiKey(provider, key);
  },
  [IPC.brainListOllamaModels]: (baseUrl?: string): Promise<string[]> => listOllamaModels(baseUrl || undefined),
  [IPC.codingGetConfig]: async (): Promise<CodingConfig & { projectsRoot: string }> => ({ ...(await loadCodingConfig()), projectsRoot: defaultProjectsRoot() }),
  [IPC.codingSetConfig]: (patch: Partial<CodingConfig>): Promise<CodingConfig> => saveCodingConfig(patch),
  [IPC.mcpGetConfig]: (): Promise<McpConfig> => loadMcpConfig(),
  [IPC.mcpSetConfig]: async (config: McpConfig): Promise<McpConfig> => {
    const saved = await saveMcpConfig(config);
    void mcpManager.ensure(saved.servers);
    return saved;
  },
  [IPC.mcpStatus]: async (retryId?: string): Promise<McpServerStatus[]> => {
    const { servers } = await loadMcpConfig();
    if (retryId) mcpManager.retry(retryId);
    await mcpManager.ensure(servers);
    return mcpManager.status(servers);
  },
  [IPC.mcpPresets]: (): McpPreset[] => mcpPresets(defaultProjectsRoot()),
  [IPC.teamGetConfig]: (): Promise<TeamConfig> => loadTeamConfig(),
  [IPC.teamSetConfig]: async (patch: Partial<TeamConfig>): Promise<TeamConfig> => {
    clearProbeCache();
    const team = await saveTeamConfig(patch);
    // Choosing Hermes on the team's models: the PC's Head gets the 64K context Hermes needs.
    await makeHeadHermesReady(team).catch((err: unknown) => console.warn("[mimir] couldn't give the Head 64K context:", err instanceof Error ? err.message : err));
    return team;
  },
  [IPC.teamPresets]: (): TeamPreset[] => TEAM_PRESETS,
  [IPC.teamApplyPreset]: (id: string, pcAddress?: string): Promise<TeamConfig> => { clearProbeCache(); return applyTeamPreset(id, pcAddress); },
  [IPC.teamStatus]: async (): Promise<RoleStatus[]> => { clearProbeCache(); return teamStatus(await loadTeamConfig()); },
  [IPC.teamListModels]: async (endpoint: RoleEndpoint): Promise<string[]> => (await probeEndpoint(endpoint)).models,
  [IPC.setupGet]: () => setupView(),
  [IPC.setupSetConfig]: async (patch: Partial<SetupConfig>) => {
    await saveSetupConfig(patch);
    return setupView();
  },
  [IPC.setupRun]: async (id: string) => {
    try {
      return { ok: true, message: await runSetupStep(id), view: await setupView() };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), view: await setupView() };
    }
  },
  [IPC.teamCheckEngine]: async (engine: "claude-code" | "opencode" | "hermes") => {
    const team = await loadTeamConfig();
    return checkEngine(engine, team.engineCommands[engine] ?? (engine === "claude-code" ? "claude" : engine));
  },
  [IPC.hermesInstall]: async () => {
    const team = await loadTeamConfig();
    return hermes.start({ configured: team.engineCommands.hermes, honcho: team.honcho.enabled });
  },
  [IPC.hermesInstallStatus]: async () => {
    const team = await loadTeamConfig();
    // Not installing now: whether Hermes is there, found where the installer puts it too.
    const found = hermes.state.running ? null : await findHermes(team.engineCommands.hermes);
    return { ...hermes.state, found };
  },
  [IPC.modelsLibrary]: () => libraryView(),
  [IPC.aiCheck]: () => checkAi(),
  [IPC.modelsQuants]: (repo: string) => repoQuants(String(repo)),
  [IPC.modelsDownload]: (repo: string, quant: string) => downloads.start(String(repo).trim(), String(quant).trim()),
  [IPC.modelsPause]: (id: string) => downloads.pause(String(id)),
  [IPC.modelsRemove]: (id: string) => downloads.remove(String(id)),
  [IPC.modelsUse]: (file: string, role: "head" | "executor" | "checker") => {
    if (role !== "head" && role !== "executor" && role !== "checker") throw new Error("Pick Head, Executor or Checker.");
    return useModel(String(file), role);
  },
  [IPC.teamSetHonchoKey]: async (key: string): Promise<TeamConfig> => {
    await setSecret(HONCHO_KEY, key.trim());
    const team = await loadTeamConfig();
    return saveTeamConfig({ honcho: { ...team.honcho, keySaved: key.trim().length > 0 } });
  },
  [IPC.chatsList]: (): Promise<MimirChatSummary[]> => listMimirChats(),
  [IPC.chatsGet]: (id: string): Promise<MimirChat | null> => readMimirChat(id),
  [IPC.chatsSave]: (chat: unknown): Promise<MimirChat | null> => writeMimirChat(chat),
  [IPC.chatsDelete]: (id: string): Promise<void> => deleteMimirChat(id),
  [IPC.chatsOpen]: async (id: string | null): Promise<MimirChat | null> => {
    const chat = id ? await readMimirChat(id) : null;
    session?.openConversation(chat ? historyFromChat(chat) : []);
    return chat;
  },
  [IPC.memoryGet]: (): Promise<MemoryFiles> => readMemoryFiles(workspaceRoot),
  [IPC.obsidianGet]: async () => {
    const config = await loadObsidianConfig();
    const client = bridgeDeckFromEnv();
    const bd = client ? await client.call<{ enabled: boolean; path: string }>("vault").catch(() => null) : null;
    return { ...config, bridgedeck: client ? { enabled: !!bd?.enabled, path: bd?.path ?? "" } : null };
  },
  [IPC.jarvisBrief]: async () => {
    const [team, brain] = await Promise.all([loadTeamConfig(), loadBrainConfig()]);
    const engine = team.engine === "mimir" ? `Mimir · ${team.mode === "team" ? `team (${team.roles.head.primary.model})` : brain.model}` : `${team.engine === "claude-code" ? "Claude Code" : team.engine === "opencode" ? "OpenCode" : "Hermes"} · ${team.engineModels === "team" ? team.roles.head.primary.model : "its own models"}`;
    return jarvisBrief(bridgeDeckFromEnv(), engine);
  },
  [IPC.obsidianSet]: (vault: string | null, useBridgeDeck?: boolean) => saveObsidianConfig(vault, useBridgeDeck !== false),
  [IPC.memorySet]: (patch: { memory?: string; user?: string }): Promise<MemoryFiles> =>
    writeMemoryFiles(workspaceRoot, new SelfEditTransaction(workspaceRoot, auditFilePath), { memory: patch?.memory, user: patch?.user }),
  [IPC.voiceGetConfig]: (): Promise<VoiceConfig> => loadVoiceConfig(),
  [IPC.voiceSetConfig]: async (
    patch: Partial<Pick<VoiceConfig, "wakeWordEnabled" | "openMicEnabled" | "ttsProvider" | "naturalVoice" | "elevenLabsVoiceId" | "systemVoice" | "wakeWordPath" | "followUpListenSeconds">>
  ): Promise<VoiceConfig> => {
    const next = await saveVoiceConfig(patch);
    // React to a live toggle of the wake word without requiring a restart.
    if (next.wakeWordEnabled) await startWake();
    else stopWake();
    return next;
  },
  [IPC.voicePrepare]: async (): Promise<VoiceConfig> => {
    try {
      await loadNaturalVoice();
    } catch {
      /* the error is in the config's naturalVoiceError */
    }
    return loadVoiceConfig();
  },
  [IPC.voiceSetApiKey]: async (kind: "picovoice" | "elevenlabs", key: string): Promise<void> => {
    if (kind === "picovoice") await setPicovoiceKey(key);
    else await setElevenLabsKey(key);
  },
  [IPC.auditList]: () => session?.listAudit() ?? [],
  [IPC.auditRevert]: async (auditId: string) => {
    if (!session) return { ok: false, error: "No active session." };
    return session.revertAudit(auditId);
  },
  [IPC.personaGetConfig]: (): Promise<PersonaConfig> => loadPersonaConfig(),
  [IPC.personaSetConfig]: (patch: Partial<PersonaConfig>): Promise<PersonaConfig> => savePersonaConfig(patch),
  [IPC.projectsGetRoot]: (): string => defaultProjectsRoot(),
  [IPC.projectsOpenFolder]: () => openFolder(defaultProjectsRoot()),
  [IPC.skillsGetRoot]: (): string => defaultSkillsRoot(),
  [IPC.skillsList]: (): Promise<SkillSummary[]> => listSkillSummaries(defaultSkillsRoot()),
  [IPC.skillsListBuiltIns]: (): Promise<BuiltInCapability[]> => listBuiltInCapabilities(workspaceRoot, auditFilePath),
  [IPC.skillsListModules]: (): Promise<PromptModuleInfo[]> => listPromptModules(workspaceRoot, auditFilePath),
  [IPC.skillsVerify]: (name: string): Promise<SkillSummary | null> => verifySkillNow(defaultSkillsRoot(), name, runPythonInRenderer),
  [IPC.skillsOpenFolder]: () => openFolder(defaultSkillsRoot()),
  // A running skill's Python called one of its declared host capabilities. Re-checked here against
  // the app-wide allowlist and this run's declared capabilities: main never trusts the UI alone.
  [IPC.pythonHostCall]: async (req: { capability: string; args: Record<string, unknown>; declaredCapabilities: string[] }) => {
    const { capability, args, declaredCapabilities } = req;
    if (!isCapabilityDeclaredForRun(capability, declaredCapabilities)) {
      return { error: `"${capability}" was not declared as a capability for this skill.` };
    }
    broadcast(IPC.faceState, "thinking");
    broadcast(IPC.chatStream, { type: "tool-start", name: capability });
    const result = await hostCapabilityDispatch(capability, args);
    broadcast(IPC.chatStream, { type: "tool-end", name: capability, isError: result.isError ?? false });
    return result.isError ? { error: result.content } : { content: result.content };
  }
};

/** Fire-and-forget channels (Electron's ipcMain.on). */
const sendHandlers: Record<string, Handler> = {
  [IPC.approvalDecide]: (id: string, allow: boolean) => session?.resolveApproval(id, allow ? "approved" : "rejected"),
  [IPC.chatSend]: (text: string, attachments?: Attachment[]) => void session?.send(text, attachments),
  [IPC.chatStop]: () => session?.stop(),
  [IPC.editApprove]: (pendingId: string) => session?.resolveApproval(pendingId, "approved"),
  [IPC.editReject]: (pendingId: string) => session?.resolveApproval(pendingId, "rejected"),
  // Avoid the wake word double-triggering while the user is manually talking.
  [IPC.voicePushToTalkStart]: () => stopWake(),
  [IPC.voicePushToTalkStop]: () =>
    void loadVoiceConfig().then(async (cfg) => {
      if (cfg.wakeWordEnabled) await startWake();
    }),
  [IPC.pythonRunResponse]: (reply: { id: string } & PythonRunResult) => {
    const resolve = pendingPythonRequests.get(reply.id);
    if (resolve) {
      pendingPythonRequests.delete(reply.id);
      resolve(reply);
    }
  },
  [IPC.semanticSearchResponse]: (reply: { id: string; hits: SemanticSearchHit[] }) => {
    const resolve = pendingSemanticSearchRequests.get(reply.id);
    if (resolve) {
      pendingSemanticSearchRequests.delete(reply.id);
      resolve(reply.hits);
    }
  }
};

/** The channels BridgeDeck's own settings may use, over POST /control (its webview can't open a
 * WebSocket here, and a second socket would take the chat events from the Mimir tab). */
export const CONTROL_CHANNELS = new Set<string>([
  IPC.teamGetConfig, IPC.teamSetConfig, IPC.teamStatus, IPC.teamCheckEngine, IPC.teamSetHonchoKey,
  IPC.hermesInstall, IPC.hermesInstallStatus,
  IPC.obsidianGet, IPC.obsidianSet,
  IPC.modelsLibrary, IPC.modelsQuants, IPC.modelsDownload, IPC.modelsPause, IPC.modelsRemove, IPC.modelsUse,
  IPC.aiCheck
]);

/** Whether a request carries this run's token (Authorization: Bearer …). */
export function authorized(header: string | undefined, expected: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  if (req.method !== "POST") return void reply(405, { ok: false, error: "POST only" });
  if (!authorized(req.headers.authorization, token)) return void reply(401, { ok: false, error: "Wrong token" });
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 1_000_000) return void reply(413, { ok: false, error: "Too big" });
  }
  let message: { ch?: unknown; args?: unknown };
  try {
    message = JSON.parse(raw) as typeof message;
  } catch {
    return void reply(400, { ok: false, error: "Not JSON" });
  }
  const ch = typeof message.ch === "string" ? message.ch : "";
  const handler = CONTROL_CHANNELS.has(ch) ? invokeHandlers[ch] : undefined;
  if (!handler) return void reply(404, { ok: false, error: `Unknown channel ${ch}` });
  try {
    reply(200, { ok: true, value: (await handler(...((Array.isArray(message.args) ? message.args : []) as never[]))) ?? null });
  } catch (error) {
    reply(200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

type Incoming = { t: "invoke"; id: number; ch: string; args?: unknown[] } | { t: "send"; ch: string; args?: unknown[] };

async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
  let message: Incoming;
  try {
    message = JSON.parse(raw) as Incoming;
  } catch {
    return;
  }
  const args = Array.isArray(message.args) ? (message.args as never[]) : [];
  if (message.t === "send") {
    sendHandlers[message.ch]?.(...args);
    return;
  }
  if (message.t !== "invoke" || typeof message.id !== "number") return;
  const handler = invokeHandlers[message.ch];
  if (!handler) {
    post(socket, { t: "result", id: message.id, ok: false, error: `Unknown channel ${message.ch}` });
    return;
  }
  try {
    post(socket, { t: "result", id: message.id, ok: true, value: await handler(...args) });
  } catch (error) {
    post(socket, { t: "result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// --- HTTP: the built renderer ---------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8"
};

/** A request path inside RENDERER_DIR, or null if it would leave it. */
export function rendererFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  const relative = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(root, relative);
  const inside = path.relative(root, resolved);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
  return resolved;
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const file = rendererFile(RENDERER_DIR, req.url ?? "/");
  try {
    if (!file || !(await stat(file)).isFile()) throw new Error("not found");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin"
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

// --- Start ---------------------------------------------------------------

async function main(): Promise<void> {
  await bootstrapWorkspace(APP_ROOT, workspaceRoot);

  session = new AgentSession({
    win: ui,
    workspaceRoot,
    auditFilePath,
    relaunch: () => {
      console.log("[mimir] restarting into the new build");
      setTimeout(() => process.exit(RELAUNCH_EXIT_CODE), 200);
    },
    runPython: runPythonInRenderer,
    resetPython: () => broadcast(IPC.pythonRunRequest, { reset: true }),
    semanticSearch: runSemanticSearchInRenderer
  });

  const server = http.createServer((req, res) => void ((req.url ?? "").split("?")[0] === "/control" ? handleControl(req, res) : serveStatic(req, res)));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/rpc" || url.searchParams.get("token") !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      primary = ws;
      post(ws, { t: "hello", bootId });
      ws.on("message", (data) => void handleMessage(ws, data.toString()));
      ws.on("close", () => {
        clients.delete(ws);
        if (primary === ws) primary = [...clients].pop() ?? null;
      });
    });
  });

  const port = Number(process.env.MIMIR_PORT) || 0;
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`MIMIR_LISTENING ${JSON.stringify({ port: actualPort, token })}`);

  const voiceConfig = await loadVoiceConfig();
  if (voiceConfig.wakeWordEnabled) await startWake();
  // Hands-free voice on: have the natural voice ready for the first reply instead of the system one.
  if (voiceConfig.ttsProvider === "natural" && (voiceConfig.wakeWordEnabled || voiceConfig.openMicEnabled)) void loadNaturalVoice().catch(() => undefined);
  startHeartbeatScheduler(workspaceRoot, auditFilePath);
  startDeadlineNotifier(workspaceRoot);
  await reportHealthy();
  void syncTeamWithSetup().catch(() => false);
  void autostartSwap();
  startLoadWatch();

  const shutdown = () => {
    void mcpManager.closeAll();
    session?.closeEngines();
    swap.stop();
    stopWake();
    stopHeartbeatScheduler();
    stopDeadlineNotifier();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // BridgeDeck closes our stdin when it goes away; don't outlive it.
  if (process.env.MIMIR_EXIT_WITH_STDIN === "1") {
    process.stdin.on("end", shutdown);
    process.stdin.resume();
  }
}

if (process.env.MIMIR_NO_AUTOSTART !== "1") {
  installCrashLog();
  void pruneLogs();
  main().catch((error) => {
    recordCrash("failed to start", error);
    console.error("[mimir] failed to start:", error);
    process.exit(1);
  });
}
