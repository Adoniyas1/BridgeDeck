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
  | { type: "tool-start"; name: string }
  | { type: "tool-end"; name: string; isError: boolean }
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
export type AgentEngine = "mimir" | "claude-code" | "opencode";

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
  engine: AgentEngine;
  roles: Record<BrainRole, RoleConfig>;
  /** The Checker uses the Head's model (no extra model to load). */
  checkerSameAsHead: boolean;
  /** Check every step as it finishes (better when models stay loaded), or all steps at the end
   * (fewer model swaps on a small machine). */
  checkEachStep: boolean;
  /** The preset this came from, if any. */
  preset: string | null;
}

export interface TeamPreset {
  id: string;
  title: string;
  description: string;
  /** The preset needs the other computer's address (e.g. "192.168.1.20:8080"). */
  needsPcAddress: boolean;
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
  ttsProvider: "system" | "elevenlabs";
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
  chatSpeak: "mimir:chat:speak",
  faceState: "mimir:face:state",
  brainGetConfig: "mimir:brain:get-config",
  brainSetConfig: "mimir:brain:set-config",
  brainSetApiKey: "mimir:brain:set-api-key",
  /** Queries Ollama's own /api/tags for models actually installed locally,
   * so the model picker can auto-detect rather than requiring free text. */
  brainListOllamaModels: "mimir:brain:list-ollama-models",
  teamGetConfig: "mimir:team:get-config",
  teamSetConfig: "mimir:team:set-config",
  teamPresets: "mimir:team:presets",
  teamApplyPreset: "mimir:team:apply-preset",
  teamStatus: "mimir:team:status",
  teamListModels: "mimir:team:list-models",
  voiceGetConfig: "mimir:voice:get-config",
  voiceSetConfig: "mimir:voice:set-config",
  voiceSetApiKey: "mimir:voice:set-api-key",
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
