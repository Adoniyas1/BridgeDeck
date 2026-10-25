/**
 * `window.mimir`: the renderer's only way to reach the main process. Under
 * Electron this came from a preload script over IPC; inside BridgeDeck the
 * page is served by Mimir's own process (src/main/server.ts) and the same
 * channels travel over a WebSocket to it. The URL carries the token that
 * process printed, so only the BridgeDeck tab that was handed it can connect.
 *
 * The page also listens to its BridgeDeck parent: the voice hotkey is a
 * BridgeDeck shortcut, forwarded here with postMessage.
 */
import {
  IPC,
  type Attachment,
  type AuditEntry,
  type BrainConfig,
  type BrainProviderKind,
  type BuiltInCapability,
  type SetupConfig,
  type SetupView,
  type ChatGptChat,
  type ChatGptChatSummary,
  type MemoryFiles,
  type MimirChat,
  type MimirChatSummary,
  type ChatGptConfig,
  type ChatGptStreamEvent,
  type PromptModuleInfo,
  type McpPreset,
  type McpServerConfig,
  type McpServerStatus,
  type RoleEndpoint,
  type RoleStatus,
  type TeamConfig,
  type TeamPreset,
  type ChatStreamEvent,
  type FaceState,
  type PersonaConfig,
  type PythonRunRequest,
  type PythonRunResult,
  type SemanticSearchHit,
  type SemanticSearchRequest,
  type SkillSummary,
  type VoiceConfig
} from "../shared/types.js";

type Listener = (...args: unknown[]) => void;
type Incoming = { t: "hello"; bootId: string } | { t: "event"; ch: string; args: unknown[] } | { t: "result"; id: number; ok: boolean; value?: unknown; error?: string };

const params = new URLSearchParams(location.search);
const token = params.get("token") ?? "";
const listeners = new Map<string, Set<Listener>>();
/** Questions from BridgeDeck (not an IPC channel: they come from the page around this one). */
const ASK = "bridgedeck:ask";

/** Inside BridgeDeck (its Mimir tab): this page is in a frame BridgeDeck made. */
const embedded = window.parent !== window;
export type BridgeDeckTab = { title: string; text: string };
const contextWaiting = new Map<number, (ctx: BridgeDeckTab | null) => void>();
let contextSeq = 0;

/** What's open in BridgeDeck: the last tab worked in that has something to ask about (a circuit, a
 * program), or null (not in BridgeDeck, nothing open, or no answer in time). */
function bridgeDeckContext(): Promise<BridgeDeckTab | null> {
  if (!embedded) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = ++contextSeq;
    contextWaiting.set(id, resolve);
    window.parent.postMessage({ source: "mimir", type: "context-request", id }, "*");
    setTimeout(() => {
      if (contextWaiting.delete(id)) resolve(null);
    }, 2000);
  });
}
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const queue: string[] = [];
let socket: WebSocket | null = null;
let nextId = 1;
let bootId: string | null = null;
let retryMs = 500;

function connect(): void {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc?token=${encodeURIComponent(token)}`);
  socket = ws;
  ws.onopen = () => {
    retryMs = 500;
    while (queue.length && ws.readyState === WebSocket.OPEN) ws.send(queue.shift()!);
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Incoming;
    if (message.t === "hello") {
      // A different process answered: Mimir restarted (perhaps into a self-edited build), so load
      // its own renderer rather than talking to it with this one.
      if (bootId && bootId !== message.bootId) location.reload();
      bootId = message.bootId;
    } else if (message.t === "event") {
      listeners.get(message.ch)?.forEach((cb) => cb(...message.args));
    } else if (message.t === "result") {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.ok) waiting.resolve(message.value);
      else waiting.reject(new Error(message.error ?? "Mimir request failed"));
    }
  };
  ws.onclose = () => {
    socket = null;
    // Requests that were waiting on the old connection won't get an answer.
    for (const [id, waiting] of pending) {
      waiting.reject(new Error("Lost the connection to Mimir"));
      pending.delete(id);
    }
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
}

function transmit(message: object): void {
  const raw = JSON.stringify(message);
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(raw);
  else queue.push(raw);
}

function send(ch: string, ...args: unknown[]): void {
  transmit({ t: "send", ch, args });
}

function invoke<T>(ch: string, ...args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    transmit({ t: "invoke", id, ch, args });
  });
}

function on<A extends unknown[]>(ch: string, cb: (...args: A) => void): () => void {
  const set = listeners.get(ch) ?? new Set<Listener>();
  listeners.set(ch, set);
  const listener = cb as Listener;
  set.add(listener);
  return () => set.delete(listener);
}

const api = {
  chat: {
    send: (text: string, attachments?: Attachment[]) => send(IPC.chatSend, text, attachments),
    stop: () => send(IPC.chatStop),
    speak: (text: string): Promise<void> => invoke(IPC.chatSpeak, text),
    onStream: (cb: (event: ChatStreamEvent) => void) => on(IPC.chatStream, cb),
    /** A question BridgeDeck hands over (e.g. "Ask Mimir about this error" in its Code tab). */
    onAsk: (cb: (text: string) => void) => on(ASK, cb)
  },
  bridgedeck: {
    embedded,
    context: bridgeDeckContext
  },
  face: {
    onState: (cb: (state: FaceState) => void) => on(IPC.faceState, cb)
  },
  brain: {
    getConfig: (): Promise<BrainConfig> => invoke(IPC.brainGetConfig),
    setConfig: (patch: Partial<Omit<BrainConfig, "hasApiKey">>): Promise<BrainConfig> => invoke(IPC.brainSetConfig, patch),
    setApiKey: (provider: BrainProviderKind, key: string): Promise<void> => invoke(IPC.brainSetApiKey, provider, key),
    listOllamaModels: (baseUrl?: string): Promise<string[]> => invoke(IPC.brainListOllamaModels, baseUrl)
  },
  team: {
    getConfig: (): Promise<TeamConfig> => invoke(IPC.teamGetConfig),
    setConfig: (patch: Partial<TeamConfig>): Promise<TeamConfig> => invoke(IPC.teamSetConfig, patch),
    presets: (): Promise<TeamPreset[]> => invoke(IPC.teamPresets),
    applyPreset: (id: string, pcAddress?: string): Promise<TeamConfig> => invoke(IPC.teamApplyPreset, id, pcAddress),
    status: (): Promise<RoleStatus[]> => invoke(IPC.teamStatus),
    listModels: (endpoint: RoleEndpoint): Promise<string[]> => invoke(IPC.teamListModels, endpoint),
    checkEngine: (engine: "claude-code" | "opencode" | "hermes"): Promise<{ ok: boolean; detail: string }> => invoke(IPC.teamCheckEngine, engine),
    setHonchoKey: (key: string): Promise<TeamConfig> => invoke(IPC.teamSetHonchoKey, key)
  },
  setup: {
    get: (): Promise<SetupView> => invoke(IPC.setupGet),
    setConfig: (patch: Partial<SetupConfig>): Promise<SetupView> => invoke(IPC.setupSetConfig, patch),
    run: (id: string): Promise<{ ok: boolean; message: string; view: SetupView }> => invoke(IPC.setupRun, id)
  },
  chats: {
    list: (): Promise<MimirChatSummary[]> => invoke(IPC.chatsList),
    get: (id: string): Promise<MimirChat | null> => invoke(IPC.chatsGet, id),
    save: (chat: MimirChat): Promise<MimirChat | null> => invoke(IPC.chatsSave, chat),
    remove: (id: string): Promise<void> => invoke(IPC.chatsDelete, id),
    open: (id: string | null): Promise<MimirChat | null> => invoke(IPC.chatsOpen, id)
  },
  memory: {
    get: (): Promise<MemoryFiles> => invoke(IPC.memoryGet),
    set: (patch: { memory?: string; user?: string }): Promise<MemoryFiles> => invoke(IPC.memorySet, patch),
    obsidian: (): Promise<{ vault: string | null }> => invoke(IPC.obsidianGet),
    setObsidian: (vault: string | null): Promise<{ vault: string | null; warning?: string }> => invoke(IPC.obsidianSet, vault)
  },
  chatgpt: {
    getConfig: (): Promise<ChatGptConfig> => invoke(IPC.chatgptGetConfig),
    setConfig: (patch: Partial<Omit<ChatGptConfig, "hasApiKey">>): Promise<ChatGptConfig> => invoke(IPC.chatgptSetConfig, patch),
    setApiKey: (key: string): Promise<ChatGptConfig> => invoke(IPC.chatgptSetApiKey, key),
    listModels: (): Promise<string[]> => invoke(IPC.chatgptListModels),
    listChats: (): Promise<ChatGptChatSummary[]> => invoke(IPC.chatgptListChats),
    getChat: (id: string): Promise<ChatGptChat | null> => invoke(IPC.chatgptGetChat, id),
    deleteChat: (id: string): Promise<void> => invoke(IPC.chatgptDeleteChat, id),
    send: (chatId: string, text: string, model?: string): Promise<ChatGptChat> => invoke(IPC.chatgptSend, chatId, text, model),
    stop: (chatId: string) => send(IPC.chatgptStop, chatId),
    saveToNotes: (id: string): Promise<{ noteId: string }> => invoke(IPC.chatgptSaveToNotes, id),
    onStream: (cb: (event: ChatGptStreamEvent) => void) => on(IPC.chatgptStream, cb)
  },
  voice: {
    getConfig: (): Promise<VoiceConfig> => invoke(IPC.voiceGetConfig),
    setConfig: (
      patch: Partial<Pick<VoiceConfig, "wakeWordEnabled" | "openMicEnabled" | "ttsProvider" | "naturalVoice" | "elevenLabsVoiceId" | "systemVoice" | "wakeWordPath" | "followUpListenSeconds">>
    ): Promise<VoiceConfig> => invoke(IPC.voiceSetConfig, patch),
    setApiKey: (kind: "picovoice" | "elevenlabs", key: string): Promise<void> => invoke(IPC.voiceSetApiKey, kind, key),
    prepare: (): Promise<VoiceConfig> => invoke(IPC.voicePrepare),
    pushToTalkStart: () => send(IPC.voicePushToTalkStart),
    pushToTalkStop: () => send(IPC.voicePushToTalkStop),
    onWakeTriggered: (cb: () => void) => on(IPC.voiceWakeTriggered, cb),
    onHotkeyTriggered: (cb: () => void) => on(IPC.voiceHotkeyTriggered, cb)
  },
  coding: {
    getConfig: (): Promise<{ root: string | null; projectsRoot: string }> => invoke(IPC.codingGetConfig),
    setConfig: (patch: { root: string | null }): Promise<{ root: string | null }> => invoke(IPC.codingSetConfig, patch)
  },
  approval: {
    decide: (id: string, allow: boolean) => send(IPC.approvalDecide, id, allow)
  },
  mcp: {
    getConfig: (): Promise<{ servers: McpServerConfig[] }> => invoke(IPC.mcpGetConfig),
    setConfig: (config: { servers: McpServerConfig[] }): Promise<{ servers: McpServerConfig[] }> => invoke(IPC.mcpSetConfig, config),
    status: (retryId?: string): Promise<McpServerStatus[]> => invoke(IPC.mcpStatus, retryId),
    presets: (): Promise<McpPreset[]> => invoke(IPC.mcpPresets)
  },
  edit: {
    approve: (pendingId: string) => send(IPC.editApprove, pendingId),
    reject: (pendingId: string) => send(IPC.editReject, pendingId)
  },
  audit: {
    list: (): Promise<AuditEntry[]> => invoke(IPC.auditList),
    revert: (auditId: string): Promise<{ ok: boolean; error?: string }> => invoke(IPC.auditRevert, auditId)
  },
  persona: {
    getConfig: (): Promise<PersonaConfig> => invoke(IPC.personaGetConfig),
    setConfig: (patch: Partial<PersonaConfig>): Promise<PersonaConfig> => invoke(IPC.personaSetConfig, patch)
  },
  projects: {
    getRoot: (): Promise<string> => invoke(IPC.projectsGetRoot),
    openFolder: (): Promise<{ ok: boolean; error?: string }> => invoke(IPC.projectsOpenFolder)
  },
  skills: {
    getRoot: (): Promise<string> => invoke(IPC.skillsGetRoot),
    list: (): Promise<SkillSummary[]> => invoke(IPC.skillsList),
    listBuiltIns: (): Promise<BuiltInCapability[]> => invoke(IPC.skillsListBuiltIns),
    listModules: (): Promise<PromptModuleInfo[]> => invoke(IPC.skillsListModules),
    verify: (name: string): Promise<SkillSummary | null> => invoke(IPC.skillsVerify, name),
    openFolder: (): Promise<{ ok: boolean; error?: string }> => invoke(IPC.skillsOpenFolder)
  },
  python: {
    onRunRequest: (cb: (req: PythonRunRequest) => void) => on(IPC.pythonRunRequest, cb),
    sendResult: (id: string, result: PythonRunResult) => send(IPC.pythonRunResponse, { id, ...result }),
    /** A running skill's Python code called a declared host capability (see compute/hostCapabilities.ts). */
    hostCall: (capability: string, args: Record<string, unknown>, declaredCapabilities: string[]): Promise<{ content?: string; error?: string }> =>
      invoke(IPC.pythonHostCall, { capability, args, declaredCapabilities })
  },
  search: {
    onSearchRequest: (cb: (req: SemanticSearchRequest) => void) => on(IPC.semanticSearchRequest, cb),
    sendResult: (id: string, hits: SemanticSearchHit[]) => send(IPC.semanticSearchResponse, { id, hits })
  }
};

export type MimirApi = typeof api;

// The voice hotkey is registered by BridgeDeck (this page has no global shortcuts of its own).
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || window.parent === window) return;
  const data = event.data as { source?: string; type?: string } | null;
  if (data?.source === "bridgedeck" && data.type === "voice-hotkey") {
    listeners.get(IPC.voiceHotkeyTriggered)?.forEach((cb) => cb());
  }
  const ask = event.data as { source?: string; type?: string; text?: unknown } | null;
  const text = typeof ask?.text === "string" ? ask.text.trim().slice(0, 20000) : "";
  if (ask?.source === "bridgedeck" && ask.type === "ask" && text) listeners.get(ASK)?.forEach((cb) => cb(text));
  const reply = event.data as { source?: string; type?: string; id?: unknown; context?: { title?: unknown; text?: unknown } | null } | null;
  if (reply?.source === "bridgedeck" && reply.type === "context" && typeof reply.id === "number") {
    const done = contextWaiting.get(reply.id);
    contextWaiting.delete(reply.id);
    const c = reply.context;
    done?.(c && typeof c.title === "string" && typeof c.text === "string" ? { title: c.title.slice(0, 200), text: c.text.slice(0, 16000) } : null);
  }
});

window.mimir = api;
connect();
