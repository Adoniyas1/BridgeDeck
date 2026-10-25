/**
 * Types shared between the Electron main process and the renderer.
 * Keep this file free of Node-only or DOM-only APIs.
 */

export type FaceState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type ChatRole = "user" | "assistant" | "system";

/** A file attached to a chat message. `data` is base64 for image/document,
 * raw text for "text" (code/markdown/plain files). See the fuller doc
 * comment on the main-process copy of this type in src/main/brain/Provider.ts. */
export interface Attachment {
  kind: "image" | "document" | "text";
  mimeType: string;
  data: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  /** Present when this message represents a self-edit proposal awaiting approval. */
  pendingEdit?: PendingEdit;
  /** The Brain team's plan and steps for this reply, when a team answered. */
  team?: TeamProgress;
  /** What the model thought before answering (when thinking is on), shown folded above the reply. */
  thinking?: string;
  /** How long it thought, in milliseconds, once the reply started. */
  thinkingMs?: number;
}

/** One of Mimir's own conversations, saved in ~/.mimir/chats/<id>.json. */
export interface MimirChat {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type MimirChatSummary = Pick<MimirChat, "id" | "title" | "updatedAt">;

/** What Mimir remembers: MEMORY.md (facts it saved) and USER.md (about the user), in its workspace. */
export interface MemoryFiles {
  memory: string;
  user: string;
  /** Where the files are, to show the user. */
  folder: string;
}

/** A tool call waiting for the user to allow or deny it (src/main/approvals.ts). */
export interface ToolApproval {
  id: string;
  /** The tool's name as the model called it. */
  tool: string;
  /** One line: what it wants to do. */
  title: string;
  /** The specifics: the command, the file and the change, the arguments. */
  detail: string;
}

/** An MCP server Mimir starts and uses tools from (src/main/mcp). */
export interface McpServerConfig {
  /** Short id used in tool names: letters, digits, - and _. */
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  /** Words in a message that load this server's tools (for local models; cloud models always get them). */
  keywords: string[];
  /** Don't ask before tools that change things (only for servers you fully trust). */
  trusted: boolean;
}

export interface McpServerStatus {
  id: string;
  state: "off" | "starting" | "ready" | "failed";
  tools: Array<{ name: string; description: string; readOnly: boolean }>;
  error: string | null;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  /** What has to be installed for it to start. */
  needs: string;
  server: McpServerConfig;
}

export type TeamStepStatus = "running" | "checking" | "passed" | "retry" | "failed" | "head";

/** The Brain team's work on one message, shown with the reply. */
export interface TeamProgress {
  steps: Array<{ goal: string; status: TeamStepStatus | "waiting"; role: BrainRole | null; model: string | null; note?: string; tools: string[] }>;
}

/** One prompt module sent to the model this turn, with its estimated size in tokens (prompt text plus tool schemas). */
export interface LoadedPromptModule {
  id: string;
  title: string;
  tokens: number;
  reason: "required" | "matched" | "sticky" | "all";
}

/** Events pushed from main -> renderer over IPC.chatStream during one agent turn. */
export type ChatStreamEvent =
  | { type: "text-delta"; text: string }
  /** The model's thinking as it streams (only when the model shows it and thinking is on). */
  | { type: "thinking-delta"; text: string }
  /** `step` is the Brain team's step the tool ran in (0-based), when a team is working. */
  | { type: "tool-start"; name: string; step?: number | null }
  | { type: "tool-end"; name: string; isError: boolean; step?: number | null }
  /** A tool wants to do something that needs the user's OK (a command, a change outside Projects). */
  | { type: "approval-pending"; approval: ToolApproval }
  /** The Brain team's plan for this message (see src/main/team/graph.ts). */
  | { type: "team-plan"; steps: Array<{ goal: string }> }
  /** A step of the plan changed: who is on it and how it went. */
  | { type: "team-step"; index: number; status: TeamStepStatus; role: BrainRole; model: string; note?: string }
  /** A tool (currently only run_python, for matplotlib figures) produced an
   * image to show alongside the reply. Bypasses the model entirely — it's
   * shown to the user, not fed back into the conversation as text, so a
   * plot doesn't burn a huge base64 blob out of the model's own context. */
  | { type: "image"; dataUrl: string }
  | { type: "edit-pending"; pending: PendingEdit }
  /** Which prompt modules were loaded for this turn, sent before the model starts (see src/main/prompts). */
  | { type: "context"; modules: LoadedPromptModule[]; tokens: number }
  | { type: "turn-done"; fullText: string }
  | { type: "error"; message: string };

/**
 * "skill" — new/changed capability module under skills/, applies instantly.
 * "core" — touches the running app itself (src/main, src/renderer); gated
 *   behind a full verify pass and (unless auto-approve is on) user approval.
 * "persona" — a personality/memory markdown file under persona/; applies
 *   instantly like "skill" (nothing to typecheck), but tracked separately
 *   so the UI/audit log can label it distinctly.
 */
export type EditTier = "skill" | "core" | "persona";

export interface PendingEdit {
  id: string;
  summary: string;
  diff: string;
  filesTouched: string[];
  tier: EditTier;
}

export type BrainProviderKind = "anthropic" | "openai-compatible" | "ollama";

/** The three jobs in a Brain team: the Head plans and writes the answer, the Executor makes the
 * tool calls, the Checker reviews each result. See src/main/team. */
export type BrainRole = "head" | "checker" | "executor";

/** What runs a conversation: Mimir's own team loop, or a coding agent run headless (phase 5). */
export type AgentEngine = "mimir" | "claude-code" | "opencode" | "hermes";

/** How many tools a role's model gets: "auto" guesses from the model's size. */
export type ToolTierChoice = "auto" | "core" | "full";

/** One model on one server. */
export interface RoleEndpoint {
  provider: BrainProviderKind;
  model: string;
  /** Server address for ollama / openai-compatible; ignored for anthropic. */
  baseUrl: string | null;
}

export interface RoleConfig {
  /** Tried first, e.g. the Windows PC's server. */
  primary: RoleEndpoint;
  /** Used when the primary can't be reached, e.g. this Mac's own MLX server. */
  fallback: RoleEndpoint | null;
  tier: ToolTierChoice;
}

export interface TeamConfig {
  /** "single": one model does everything (the Brain setting). "team": the roles below. */
  mode: "single" | "team";
  /** Who runs the chat: Mimir itself, or Claude Code / OpenCode headless inside it. */
  engine: AgentEngine;
  /** For Claude Code and OpenCode: the team's Head and Executor models ("team"), or the agent's
   * own models and login ("own"). */
  engineModels: "team" | "own";
  /** Let local models think before answering. Off by default: on a small machine a reasoning model
   * can spend minutes thinking about a one-line answer. */
  thinking: boolean;
  /** The command for each agent, when it isn't on PATH as `claude` / `opencode`. */
  engineCommands: { "claude-code": string | null; opencode: string | null; hermes: string | null };
  roles: Record<BrainRole, RoleConfig>;
  /** The Checker uses the Head's model (no extra model to load). */
  checkerSameAsHead: boolean;
  /** Check every step as it finishes (better when models stay loaded), or all steps at the end
   * (fewer model swaps on a small machine). */
  checkEachStep: boolean;
  /** The preset this came from, if any. */
  preset: string | null;
  /** A model that can see pictures, which reads photos for a chat model that can't (team or
   * single mode). Null: pictures go to the chat model as they are. */
  vision: RoleEndpoint | null;
  /** Honcho as Hermes's memory (engines/hermes.ts): off, or on with honcho.dev (the API key is in
   * the keychain) or a self-hosted server. */
  honcho: { enabled: boolean; baseUrl: string | null; peerName: string; keySaved: boolean };
}

/** What the Jarvis view shows beside the orb (jarvis/brief.ts). */
export interface JarvisBrief {
  events: Array<{ title: string; start: number; end: number; allDay: boolean; location: string }>;
  due: Array<{ title: string; course: string; due: number }>;
  flashcards: number;
  system: { memUsed: number; memTotal: number; cpu: number };
  /** Who's answering: "Mimir · qwen3.5-9b", "Hermes · team models"… */
  engine: string;
}

export interface TeamPreset {
  id: string;
  title: string;
  description: string;
  /** The preset needs the other computer's address (e.g. "192.168.1.20:8080"). */
  needsPcAddress: boolean;
}

/** Which kind of computer the model-server setup is for: the 8 GB Mac or the Windows PC (both run llama.cpp). */
export type SetupComputer = "mac" | "pc";

/** One model llama-swap serves: the name the Brain team asks for, where it comes from (a Hugging
 * Face repo, for GGUF with a :quant tag) and extra server arguments. */
export interface SetupModel {
  name: string;
  /** A .gguf file on this computer, or a Hugging Face repo with a quant tag (repo:quant). */
  source: string;
  args: string;
}

export interface SetupConfig {
  /** 2: the Mac runs GGUF models with llama.cpp (version 1 used MLX, which ran out of memory on 8 GB). */
  version: number;
  computer: SetupComputer;
  /** The llama-server to use, when not the one Mimir finds (Bonsai-demo's, ~/.mimir/bin, PATH). */
  serverPath: string | null;
  /** Where llama-swap listens: 127.0.0.1:8080 for this computer only, 0.0.0.0:8080 to serve the Mac. */
  listen: string;
  /** Start llama-swap when Mimir starts. */
  autostart: boolean;
  /** Keep the Head and Executor loaded together instead of taking turns. */
  keepBothLoaded: boolean;
  /** The Checker gets its own model when set (null: the Head checks its own work). */
  models: { head: SetupModel; executor: SetupModel; checker: SetupModel | null };
  /** Extra folders to look in for .gguf files. */
  modelDirs: string[];
  /** How much of each model goes on the GPU, in percent (the rest runs on the CPU from RAM). */
  gpuShare: number;
  /** Unload the models as soon as Mimir is done with them (its turn over, tools and approvals included). */
  unloadWhenDone: boolean;
  /** Backup: llama-swap unloads a model after this many seconds without a request (0: never). */
  idleUnloadSecs: number;
}

/** A graphics card and its memory. On a Mac the GPU shares the computer's memory (`shared`). */
export interface GpuInfo {
  name: string;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other";
  totalBytes: number;
  usedBytes: number | null;
  freeBytes: number | null;
  shared: boolean;
}

export type SetupStepState = "done" | "todo" | "error";

/** One step of getting the models running, with whether it's done on this computer. */
export interface SetupStep {
  id: string;
  title: string;
  detail: string;
  /** What to run by hand instead (shown with a Copy button), if anything. */
  command: string | null;
  /** The button that does it from Mimir, if any. */
  action: string | null;
  state: SetupStepState;
  note: string;
}

/** Something taking up disk space that Settings can show and (when deletable) remove. */
export interface StorageItem {
  id: string;
  label: string;
  path: string;
  bytes: number;
  deletable: boolean;
  hint: string;
}

export interface SetupView {
  config: SetupConfig;
  /** Models (.gguf) and llama-server builds already on this computer. */
  found: { models: Array<{ path: string; bytes: number }>; servers: string[] };
  /** The llama-server Mimir will use, if any. */
  server: string | null;
  memory: { availableBytes: number; totalBytes: number };
  /** The graphics cards and their memory (VRAM). */
  gpus: GpuInfo[];
  /** Each model's layers and how many go on the GPU, with about how much VRAM and RAM that takes. */
  splits: Partial<Record<"head" | "executor" | "checker", { layers: number; onGpu: number; fromFile: boolean; gpuBytes: number; cpuBytes: number; moe: boolean }>>;
  storage: StorageItem[];
  steps: SetupStep[];
  /** The llama-swap config Mimir writes. */
  yaml: string;
  configPath: string;
  swapRunning: boolean;
  swapLog: string;
}

/** Which endpoint a role would use right now, and whether it answers. */
export interface RoleStatus {
  role: BrainRole;
  using: "primary" | "fallback" | "none";
  endpoint: RoleEndpoint | null;
  reachable: boolean;
  detail: string;
}

/** Anthropic's thinking-depth control. Ignored (no-op) for other providers. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface BrainConfig {
  provider: BrainProviderKind;
  model: string;
  /** Base URL for openai-compatible / ollama providers. Ignored for anthropic. */
  baseUrl: string | null;
  /** Whether an API key has been stored in the OS keychain for this provider. */
  hasApiKey: boolean;
  autoApproveCoreEdits: boolean;
  /** Anthropic-only; ignored elsewhere. */
  effort: EffortLevel;
  /** Anthropic-only server-side web_search tool; ignored elsewhere. */
  webSearchEnabled: boolean;
}

/** The ChatGPT section: OpenAI's models with the user's own API key, separate from Mimir's brain. */
export interface ChatGptConfig {
  model: string;
  /** Whether an OpenAI API key is stored in the OS keychain. */
  hasApiKey: boolean;
  /** Optional standing instructions sent with every chat (like ChatGPT's custom instructions). */
  instructions: string;
}

export interface ChatGptMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatGptChat {
  id: string;
  title: string;
  model: string;
  messages: ChatGptMessage[];
  createdAt: number;
  updatedAt: number;
  /** The BridgeDeck note this chat was saved to, so saving again updates it. */
  noteId: string | null;
}

export type ChatGptChatSummary = Pick<ChatGptChat, "id" | "title" | "model" | "updatedAt">;

/** Main -> renderer over IPC.chatgptStream while one reply is written. */
export type ChatGptStreamEvent =
  | { type: "text-delta"; chatId: string; text: string }
  | { type: "done"; chatId: string; chat: ChatGptChat }
  | { type: "error"; chatId: string; message: string };

export interface PersonaConfig {
  /** Free-text location/timezone label injected into the system prompt. */
  location: string | null;
  heartbeatEnabled: boolean;
  heartbeatIntervalMinutes: number;
  deadlineNotificationsEnabled: boolean;
}

export interface VoiceConfig {
  wakeWordEnabled: boolean;
  /** Hands-free local speech start/end detection. Off by default. */
  openMicEnabled: boolean;
  hasPicovoiceKey: boolean;
  /** natural: a neural voice on this computer (Kokoro); system: the OS voice; elevenlabs: ElevenLabs' API. */
  ttsProvider: "natural" | "system" | "elevenlabs";
  /** The Kokoro voice, one of `naturalVoices`. */
  naturalVoice: string;
  naturalVoices: Array<{ id: string; label: string }>;
  /** Whether the natural voice's model is loaded (it downloads once, about 90 MB). */
  naturalVoiceState: "not-loaded" | "loading" | "ready" | "failed";
  naturalVoiceError: string | null;
  hasElevenLabsKey: boolean;
  elevenLabsVoiceId: string;
  /** macOS `say` voice name; ignored by non-system TTS providers. */
  systemVoice: string;
  /** Absolute path to a user-downloaded custom Picovoice .ppn file. */
  wakeWordPath: string | null;
  /** Seconds to keep listening after a spoken reply before requiring the
   * wake word again. 0 disables follow-up listening entirely. */
  followUpListenSeconds: number;
}

export interface AuditEntry {
  id: string;
  commitSha: string;
  parentSha: string;
  summary: string;
  tier: EditTier;
  filesTouched: string[];
  appliedAt: number;
  status: "applied" | "reverted";
}

/** IPC channel names, centralized so main/preload/renderer never drift. */
export const IPC = {
  chatSend: "mimir:chat:send",
  chatStop: "mimir:chat:stop",
  chatStream: "mimir:chat:stream",
  /** Mimir's saved conversations (~/.mimir/chats). */
  chatsList: "mimir:chats:list",
  chatsGet: "mimir:chats:get",
  chatsSave: "mimir:chats:save",
  chatsDelete: "mimir:chats:delete",
  /** Makes a saved chat (or a new, empty one for null) the conversation Mimir continues. */
  chatsOpen: "mimir:chats:open",
  /** MEMORY.md and USER.md: what Mimir remembers, to read and edit. */
  memoryGet: "mimir:memory:get",
  memorySet: "mimir:memory:set",
  /** The Obsidian vault Mimir keeps its memory in (persona/obsidian.ts). */
  obsidianGet: "mimir:obsidian:get",
  obsidianSet: "mimir:obsidian:set",
  jarvisBrief: "mimir:jarvis:brief",
  chatSpeak: "mimir:chat:speak",
  faceState: "mimir:face:state",
  brainGetConfig: "mimir:brain:get-config",
  brainSetConfig: "mimir:brain:set-config",
  brainSetApiKey: "mimir:brain:set-api-key",
  /** Queries Ollama's own /api/tags for models actually installed locally,
   * so the model picker can auto-detect rather than requiring free text. */
  brainListOllamaModels: "mimir:brain:list-ollama-models",
  approvalDecide: "mimir:approval:decide",
  codingGetConfig: "mimir:coding:get-config",
  codingSetConfig: "mimir:coding:set-config",
  mcpGetConfig: "mimir:mcp:get-config",
  mcpSetConfig: "mimir:mcp:set-config",
  mcpStatus: "mimir:mcp:status",
  mcpPresets: "mimir:mcp:presets",
  teamGetConfig: "mimir:team:get-config",
  teamSetConfig: "mimir:team:set-config",
  teamPresets: "mimir:team:presets",
  teamApplyPreset: "mimir:team:apply-preset",
  teamStatus: "mimir:team:status",
  teamListModels: "mimir:team:list-models",
  teamCheckEngine: "mimir:team:check-engine",
  teamSetHonchoKey: "mimir:team:set-honcho-key",
  setupGet: "mimir:setup:get",
  setupSetConfig: "mimir:setup:set-config",
  setupRun: "mimir:setup:run",
  voiceGetConfig: "mimir:voice:get-config",
  voiceSetConfig: "mimir:voice:set-config",
  voiceSetApiKey: "mimir:voice:set-api-key",
  /** Loads the natural voice's model now (downloading it the first time); resolves with the voice config. */
  voicePrepare: "mimir:voice:prepare",
  voicePushToTalkStart: "mimir:voice:ptt-start",
  voicePushToTalkStop: "mimir:voice:ptt-stop",
  voiceWakeTriggered: "mimir:voice:wake-triggered",
  voiceHotkeyTriggered: "mimir:voice:hotkey-triggered",
  editApprove: "mimir:edit:approve",
  editReject: "mimir:edit:reject",
  auditList: "mimir:audit:list",
  auditRevert: "mimir:audit:revert",
  personaGetConfig: "mimir:persona:get-config",
  personaSetConfig: "mimir:persona:set-config",
  projectsGetRoot: "mimir:projects:get-root",
  projectsOpenFolder: "mimir:projects:open-folder",
  skillsGetRoot: "mimir:skills:get-root",
  skillsList: "mimir:skills:list",
  skillsListBuiltIns: "mimir:skills:list-builtins",
  skillsListModules: "mimir:skills:list-modules",
  skillsVerify: "mimir:skills:verify",
  skillsOpenFolder: "mimir:skills:open-folder",
  chatgptGetConfig: "mimir:chatgpt:get-config",
  chatgptSetConfig: "mimir:chatgpt:set-config",
  chatgptSetApiKey: "mimir:chatgpt:set-api-key",
  /** Models the key can use, from OpenAI's /v1/models. */
  chatgptListModels: "mimir:chatgpt:list-models",
  chatgptListChats: "mimir:chatgpt:list-chats",
  chatgptGetChat: "mimir:chatgpt:get-chat",
  chatgptDeleteChat: "mimir:chatgpt:delete-chat",
  /** Saves a chat as a BridgeDeck note (updates the same note on later saves). */
  chatgptSaveToNotes: "mimir:chatgpt:save-to-notes",
  /** Renderer -> main, invoke: starts a reply; returns the chat (new or existing) at once. */
  chatgptSend: "mimir:chatgpt:send",
  chatgptStop: "mimir:chatgpt:stop",
  chatgptStream: "mimir:chatgpt:stream",
  /** Main -> renderer: "please run this Python in the sandboxed worker." */
  pythonRunRequest: "mimir:python:run-request",
  /** Renderer -> main: the matching reply, correlated by request id. */
  pythonRunResponse: "mimir:python:run-response",
  /** Renderer -> main, invoke/handle (Electron already correlates the
   * reply — no separate response channel needed): a running skill's
   * sandboxed Python code called a declared host capability
   * (e.g. write_project_file) and is awaiting the result. */
  pythonHostCall: "mimir:python:host-call",
  /** Main -> renderer: "please rank this corpus against this query." */
  semanticSearchRequest: "mimir:search:request",
  /** Renderer -> main: the matching reply, correlated by request id. */
  semanticSearchResponse: "mimir:search:response"
} as const;

export interface PythonRunResult {
  stdout: string;
  result: string | null;
  error: string | null;
  /** Base64-encoded PNGs (no data: prefix) of any matplotlib figures left
   * open when the run finished. Capped at a handful per run — see
   * pyodideWorker.ts. */
  images?: string[];
}

/** Main -> renderer: run this in the sandboxed Python worker, or reset it. */
export type PythonRunRequest = { id: string; code: string; args?: Record<string, unknown>; capabilities?: string[] } | { reset: true };

/** Main -> renderer: rank this corpus against the query with the local embedding model. */
export interface SemanticSearchRequest {
  id: string;
  query: string;
  topK: number;
  corpus: ProjectFileCorpusEntry[];
}

/** One file's worth of content main sends over for the renderer to embed
 * and rank — main owns file I/O (it already has confined-path reading for
 * the Projects folder), the renderer owns the embedding model. */
export interface ProjectFileCorpusEntry {
  path: string;
  content: string;
  mtimeMs: number;
}

export interface SemanticSearchHit {
  path: string;
  snippet: string;
  score: number;
}

export type SkillStatus = "unverified" | "passed" | "failed";

/** One saved skill, for the Skill Tree view — "verified" means it actually
 * ran without raising a Python error the last time it was run, not that
 * its behavior is guaranteed correct. See src/main/skills/verification.ts.
 * category + parent place it in the tree: parent names another skill it
 * builds on (e.g. "plot_function" -> "linear_fit"), null if it's a root
 * within its category. */
export interface SkillSummary {
  name: string;
  description: string;
  code: string;
  status: SkillStatus;
  verifiedAt: number | null;
  error: string | null;
  category: string;
  parent: string | null;
  /** True when this skill declared parameters and is therefore also its
   * own real tool, skill_<name> — not just reachable via run_skill. */
  hasParameters: boolean;
}

/** A tool the current model has natively — not self-taught, just always
 * there (e.g. memory_replace, run_python). Shown in the Skills view next to
 * the skills Mimir taught itself. `category` is the title of the prompt
 * module that owns the tool; `module` is that module's id. See
 * src/main/skills/builtins.ts. */
export interface BuiltInCapability {
  name: string;
  description: string;
  category: string;
  module: string;
}

/** One prompt module, for the Skills view. Token figures are estimates of the
 * prompt text plus the tool schemas it brings, for a small ("core") model and
 * a larger ("full") one. See src/main/prompts/modules.ts. */
export interface PromptModuleInfo {
  id: string;
  title: string;
  summary: string;
  when: string;
  required: boolean;
  tiers: Array<"core" | "full">;
  tools: string[];
  coreTools: string[];
  coreTokens: number;
  fullTokens: number;
}
