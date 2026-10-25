import type { UiWindow } from "../uiChannel.js";
import { createBrainProvider, loadBrainConfig } from "../brain/index.js";
import type { Attachment, BrainMessage } from "../brain/Provider.js";
import { runAgentTurn } from "./loop.js";
import { SelfEditTransaction } from "../self-edit/transaction.js";
import { buildSelfEditToolset, type EditApprovalGate } from "../self-edit/tools.js";
import { applyCoreEditAndMaybeRestart } from "../self-edit/restart.js";
import { AuditLog } from "../self-edit/audit.js";
import { buildTurnContext, composeSystemPrompt } from "../persona/compose.js";
import { estimateTokens, STICKY_TURNS } from "../prompts/loader.js";
import { PROMPT_MODULES } from "../prompts/modules.js";
import { loadTeamConfig, roleSettings } from "../team/config.js";
import { createRoleProvider } from "../team/endpoints.js";
import { visionReading, withReading } from "../team/vision.js";
import { runTeamTurn, type RoleKit, type TeamEvent, type TeamMember } from "../team/graph.js";
import type { BrainProvider, ToolDef, ToolResult } from "../brain/Provider.js";
import { buildPersonaToolset } from "../persona/tools.js";
import { LOCAL_DAILY_LOG_INJECT_DAYS, LOCAL_MEMORY_INJECT_MAX_CHARS, LOCAL_USER_INJECT_MAX_CHARS } from "../persona/templates.js";
import { buildProjectsToolset } from "../projects/tools.js";
import { defaultProjectsRoot } from "../projects/paths.js";
import { buildComputeToolset } from "../compute/tools.js";
import { buildSkillsToolset } from "../skills/tools.js";
import { buildDynamicSkillTools } from "../skills/dynamicTools.js";
import { defaultSkillsRoot } from "../skills/paths.js";
import { buildMacToolset, openWithMac } from "../mac/tools.js";
import { bridgeDeckFromEnv } from "../bridgedeck/client.js";
import { buildBridgeDeckToolset } from "../bridgedeck/tools.js";
import { skillPacksRoot } from "../skillpacks/packs.js";
import { buildSkillPacksToolset } from "../skillpacks/tools.js";
import { buildWebToolset } from "../web/tools.js";
import { syncMemory } from "../bridgedeck/memory.js";
import { readPersonaFile } from "../persona/compose.js";
import { personaRelativePath } from "../persona/paths.js";
import { readMemoryFiles } from "../persona/memoryFiles.js";
import { buildObsidianToolset, loadObsidianConfig, syncObsidian } from "../persona/obsidian.js";
import { dailyLogDir } from "../persona/paths.js";
import { PERSONA_VERIFY_STEPS } from "../self-edit/verifyPresets.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Approver } from "../approvals.js";
import { loadMcpConfig } from "../mcp/config.js";
import { mcpManager } from "../mcp/manager.js";
import { buildCodingToolset } from "../coding/tools.js";
import { codingRoot } from "../coding/config.js";
import { EngineRunner } from "../engines/index.js";
import { engineName } from "../engines/common.js";
import { TurnLog } from "../logs/turnLog.js";
import { guardEndpoint } from "../setup/memory.js";
import type { PromptModule } from "../prompts/modules.js";
import { buildEngineeringToolset, runCalculiX, runFreeCadMacro, runKicadDrc, runKicadErc, runNgspice } from "../engineering/tools.js";
import { turnEnded, turnStarted } from "../setup/adaptive.js";
import { requiresFullEngineeringTools } from "../engineering/intent.js";
import { buildEngineeringWorkflowToolset } from "../engineering/workflow.js";
import {
  IPC,
  type ChatStreamEvent,
  type PendingEdit,
  type ProjectFileCorpusEntry,
  type PythonRunResult,
  type SemanticSearchHit
} from "../../shared/types.js";

export interface AgentSessionDeps {
  win: UiWindow;
  workspaceRoot: string;
  auditFilePath: string;
  relaunch: () => void;
  runPython: (code: string, args?: Record<string, unknown>) => Promise<PythonRunResult>;
  resetPython: () => void;
  semanticSearch: (query: string, corpus: ProjectFileCorpusEntry[], topK: number) => Promise<SemanticSearchHit[]>;
}

/**
 * Owns one conversation's history and wires the agent loop to the active
 * brain provider, the self-edit toolset, and the renderer. The provider is
 * re-resolved on every turn so a mid-conversation provider switch in
 * Settings takes effect on the very next message.
 */
export class AgentSession {
  private history: BrainMessage[] = [];
  private pendingApprovals = new Map<string, (decision: "approved" | "rejected") => void>();
  private auditLog: AuditLog;
  private activeTurnId = 0;
  private runningTurn = false;
  /** Prompt modules loaded on recent turns -> follow-up turns they stay loaded for. */
  private stickyModules = new Map<string, number>();
  /** Claude Code / OpenCode, when one of them runs the chat instead of Mimir's own loop. */
  private engines = new EngineRunner();
  private engineAbort: AbortController | null = null;

  constructor(private deps: AgentSessionDeps) {
    this.auditLog = new AuditLog(deps.auditFilePath);
  }

  private sendStream(event: ChatStreamEvent): void {
    this.deps.win.webContents.send(IPC.chatStream, event);
  }

  /** Asks the user, in the chat, to allow one tool call (see approvals.ts). */
  readonly askUser: Approver = (request) =>
    new Promise((resolve) => {
      const id = randomUUID();
      this.pendingApprovals.set(id, (decision) => resolve(decision === "approved"));
      this.sendStream({ type: "approval-pending", approval: { id, ...request } });
    });

  resolveApproval(pendingId: string, decision: "approved" | "rejected"): void {
    const resolve = this.pendingApprovals.get(pendingId);
    if (resolve) {
      resolve(decision);
      this.pendingApprovals.delete(pendingId);
    }
  }

  listAudit() {
    return this.auditLog.list();
  }

  stop(): boolean {
    if (!this.runningTurn) return false;
    // Providers do not all expose an abortable streaming request. Advancing
    // this token stops the UI turn immediately and discards any late chunks.
    this.activeTurnId++;
    this.runningTurn = false;
    this.engineAbort?.abort();
    this.engineAbort = null;
    // Anything still waiting for the user's OK is a no now.
    for (const resolve of this.pendingApprovals.values()) resolve("rejected");
    this.pendingApprovals.clear();
    this.deps.win.webContents.send(IPC.faceState, "idle");
    return true;
  }

  async revertAudit(auditId: string) {
    const transaction = new SelfEditTransaction(this.deps.workspaceRoot, this.deps.auditFilePath);
    return transaction.revert(auditId);
  }

  /** A turn holds its models from start to end (tools and approvals included); then they can go. */
  async send(userText: string, attachments?: Attachment[]): Promise<void> {
    turnStarted();
    try {
      await this.sendTurn(userText, attachments);
    } finally {
      turnEnded();
    }
  }

  private async sendTurn(userText: string, attachments?: Attachment[]): Promise<void> {
    const { win, workspaceRoot, auditFilePath, relaunch, runPython, resetPython, semanticSearch } = this.deps;
    const turnId = ++this.activeTurnId;
    this.runningTurn = true;

    // Exam mode (on either computer, in BridgeDeck): no AI help until it ends.
    const exam = await examMode();
    if (exam) {
      if (turnId !== this.activeTurnId) return;
      const until = new Date(exam.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const message = `Exam mode is on${exam.course ? ` for ${exam.course}` : ""} until ${until}, so I'm switched off until then. Good luck!`;
      this.history.push({ role: "user", content: userText, attachments });
      this.history.push({ role: "assistant", content: message });
      this.runningTurn = false;
      win.webContents.send(IPC.faceState, "idle");
      this.sendStream({ type: "text-delta", text: message });
      this.sendStream({ type: "turn-done", fullText: message });
      return;
    }

    const team = await loadTeamConfig();
    // Memory edited in Obsidian is what this message sees (and Mimir's new memory shows up there).
    const vault = await this.syncVault();
    // Pictures sent with the message are read by the vision model, when one is set, so a chat
    // model that can't see (or an outside agent that gets text only) can still work with them.
    const pictures = (attachments ?? []).filter((a) => a.kind === "image");
    if (team.vision && pictures.length) {
      win.webContents.send(IPC.faceState, "thinking");
      userText = withReading(userText, await visionReading(pictures));
      if (turnId !== this.activeTurnId) return;
    }
    if (team.engine !== "mimir") {
      await this.runEngine(team, turnId, userText, attachments, vault);
      return;
    }

    let provider;
    try {
      // On the Mac, check there's memory for a model on its own llama-swap before it loads.
      await guardEndpoint(await loadBrainConfig());
      provider = await createBrainProvider({ thinking: team.thinking });
    } catch (err) {
      if (turnId !== this.activeTurnId) return;
      this.runningTurn = false;
      this.sendStream({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const brainConfig = await loadBrainConfig();
    // The Brain team (Head, Executor, Checker) runs instead of the single model; see team/graph.ts.
    const teamMode = team.mode === "team";
    if (turnId !== this.activeTurnId) return;

    const transaction = new SelfEditTransaction(workspaceRoot, auditFilePath);
    const gate: EditApprovalGate = {
      requestApproval: (pending: PendingEdit) =>
        new Promise((resolve) => {
          this.pendingApprovals.set(pending.id, resolve);
          this.sendStream({ type: "edit-pending", pending });
        })
    };

    // A 3B local model is reliable at conversation but not at choosing among
    // a full agent toolbox. Give it a single, explicit, validated workflow
    // only when the request clearly matches it. Larger local/cloud models
    // retain the complete toolset below.
    const tier = resolveToolTier(provider);
    if (!teamMode && tier === "core" && requiresFullEngineeringTools(userText)) {
      const message = "I cannot execute a full CAD or simulation engineering project with this small local model. Select a larger tool-capable model, then ask again; I will show each project, FreeCAD, and CalculiX tool action as it runs rather than claiming work was completed.";
      this.history.push({ role: "user", content: userText, attachments });
      this.history.push({ role: "assistant", content: message });
      this.runningTurn = false;
      win.webContents.send(IPC.faceState, "idle");
      this.sendStream({ type: "text-delta", text: message });
      this.sendStream({ type: "turn-done", fullText: message });
      return;
    }
    // In team mode each role gets its own tool level, so the full set is built and each role's prompt picks.
    const selfEditEnabled = tier === "full" || teamMode;
    const selfEdit = selfEditEnabled
      ? buildSelfEditToolset({
          workspaceRoot,
          transaction,
          gate,
          getAutoApproveCoreEdits: async () => (await loadBrainConfig()).autoApproveCoreEdits,
          onCoreEditApplied: (commitSha) => {
            void applyCoreEditAndMaybeRestart(workspaceRoot, commitSha, relaunch).then((result) => {
              if (!result.ok) {
                this.sendStream({
                  type: "error",
                  message: `Core edit applied to the workspace but failed to build — the running app was not restarted:\n${result.error}`
                });
              }
            });
          }
        })
      : null;
    const persona = buildPersonaToolset({ workspaceRoot, transaction });
    const projects = buildProjectsToolset({ projectsRoot: defaultProjectsRoot(), semanticSearch });
    const compute = buildComputeToolset({ runPython, resetPython });
    const skills = buildSkillsToolset({ skillsRoot: defaultSkillsRoot(), runPython });
    const mac = buildMacToolset({ projectsRoot: defaultProjectsRoot(), open: openWithMac });
    const engineering = buildEngineeringToolset({ projectsRoot: defaultProjectsRoot(), runFreeCad: runFreeCadMacro, runCalculiX, runNgspice, runKicadErc, runKicadDrc });
    const workflow = buildEngineeringWorkflowToolset(defaultProjectsRoot());
    // BridgeDeck's notes, calendar, Messages, files… (only when BridgeDeck started this Mimir).
    const bridgedeckClient = bridgeDeckFromEnv();
    const bridgedeck = bridgedeckClient ? buildBridgeDeckToolset(bridgedeckClient) : { defs: [], handlers: {} };
    if (bridgedeckClient) {
      // MEMORY.md and the "Mimir's memory" note stay the same, before the prompt reads memory.
      await syncMemory({
        client: bridgedeckClient,
        readMemory: () => readPersonaFile(workspaceRoot, "MEMORY.md"),
        writeMemory: async (markdown) => {
          await transaction.run({ summary: "MEMORY.md edited in BridgeDeck Notes", tier: "persona", writes: [{ path: personaRelativePath("MEMORY.md"), content: markdown }], verifySteps: PERSONA_VERIFY_STEPS });
        },
        statePath: path.join(path.dirname(workspaceRoot), "bridgedeck-memory-sync.json")
      }).catch(() => undefined);
    }
    // Rebuilt fresh every turn (cheap — just a directory read per skill) so
    // a skill created mid-conversation via create_skill's parameters
    // argument is callable as its own tool on the very next turn, no
    // restart. This is the entire "the model can make a tool" mechanism.
    const dynamicSkills = await buildDynamicSkillTools({ skillsRoot: defaultSkillsRoot(), runPython });
    // Skill packs chosen in BridgeDeck's Settings (claude-skills and others in the SKILL.md format).
    const packsRoot = skillPacksRoot();
    const skillPacks = packsRoot ? buildSkillPacksToolset({ root: packsRoot, runPython }) : { defs: [], handlers: {} };
    // Searching and reading public web pages, for research with any brain.
    const web = buildWebToolset();
    // The user's Obsidian vault, when one is set (Settings → Memory).
    const obsidian = vault ? buildObsidianToolset(vault) : { defs: [], handlers: {} };
    // Tools from the MCP servers turned on in Settings (each server is a prompt module of its own).
    const mcpServers = (await loadMcpConfig()).servers;
    await mcpManager.ensure(mcpServers);
    const mcp = mcpManager.toolset(mcpServers, this.askUser);
    const extraModules: PromptModule[] = mcp.modules;
    // Claude-Code-style coding tools in the chosen folder; commands and changes outside Projects ask first.
    const coding = buildCodingToolset({ root: await codingRoot(), projectsRoot: defaultProjectsRoot(), approve: this.askUser });
    const fullDefs = [...(selfEdit?.defs ?? []), ...mcp.defs, ...coding.defs, ...persona.defs, ...projects.defs, ...compute.defs, ...skills.defs, ...mac.defs, ...engineering.defs, ...workflow.defs, ...bridgedeck.defs, ...skillPacks.defs, ...web.defs, ...obsidian.defs, ...dynamicSkills.defs];
    const fullHandlers = {
      ...mcp.handlers,
      ...coding.handlers,
      ...(selfEdit?.handlers ?? {}),
      ...persona.handlers,
      ...projects.handlers,
      ...compute.handlers,
      ...skills.handlers,
      ...mac.handlers,
      ...engineering.handlers,
      ...workflow.handlers,
      ...bridgedeck.handlers,
      ...skillPacks.handlers,
      ...web.handlers,
      ...obsidian.handlers,
      ...dynamicSkills.handlers
    };
    if (teamMode) {
      await this.runTeam({ team, turnId, userText, attachments, fullDefs, fullHandlers, extraModules, dynamicSkillTools: dynamicSkills.defs.map((d) => d.name), effort: brainConfig.effort });
      return;
    }

    // Which prompt modules (and so which tools) this turn gets. Local models get only what the message needs,
    // one module at a time within a token budget; cloud models get everything their tier allows. See prompts/.
    // Only cloud models get the whole prompt; a local model's prompt is read token by token before it answers.
    const lazy = provider.kind !== "anthropic";
    const toolCosts = new Map(fullDefs.map((d) => [d.name, estimateTokens(JSON.stringify(d))]));
    const composed = await composeSystemPrompt(workspaceRoot, {
      mode: lazy ? "lazy" : "all",
      toolTier: tier,
      userText,
      sticky: this.stickyModules,
      availableTools: new Set(fullDefs.map((d) => d.name)),
      dynamicSkillTools: dynamicSkills.defs.map((d) => d.name),
      toolCost: (name) => toolCosts.get(name) ?? 0,
      extraModules,
      // Local models spend their small context on the task: a short memory tail and the start of USER.md.
      ...(provider.kind === "anthropic"
        ? {}
        : { memoryMaxChars: LOCAL_MEMORY_INJECT_MAX_CHARS, dailyLogDays: LOCAL_DAILY_LOG_INJECT_DAYS, userMaxChars: LOCAL_USER_INJECT_MAX_CHARS })
    });
    const system = composed.system;
    // A core-tier turn can only ever offer the curated core tools plus the user's own skills (the composer
    // already limits core to those); the full tier with nothing to filter offers everything.
    const allowed = composed.toolNames;
    const isOffered = (name: string) => (allowed ? allowed.has(name) : true);
    const defs = fullDefs.filter((d) => isOffered(d.name));
    const handlers = Object.fromEntries(Object.entries(fullHandlers).filter(([name]) => isOffered(name)));
    const turnContext = provider.kind === "anthropic" ? await buildTurnContext() : "";

    for (const [id, left] of this.stickyModules) {
      if (left <= 1) this.stickyModules.delete(id);
      else this.stickyModules.set(id, left - 1);
    }
    for (const m of composed.loaded) if (m.reason === "matched") this.stickyModules.set(m.id, STICKY_TURNS);
    this.sendStream({
      type: "context",
      modules: composed.loaded.map(({ id, title, tokens, reason }) => ({ id, title, tokens, reason })),
      tokens: estimateTokens(system) + defs.reduce((sum, d) => sum + (toolCosts.get(d.name) ?? 0), 0)
    });

    this.history.push({
      role: "user",
      content: turnContext ? `${turnContext} ${userText}` : userText,
      attachments
    });
    win.webContents.send(IPC.faceState, "thinking");

    const log = new TurnLog(`one model (${provider.kind})`, userText);
    log.note(`prompt modules: ${composed.loaded.map((m) => m.id).join(", ") || "none"}`);
    let turnError = "";
    let assistantText = "";
    for await (const ev of runAgentTurn(this.history, {
      provider: log.provider(provider, "Brain"),
      system,
      tools: defs,
      handlers: log.handlers(handlers),
      effort: brainConfig.effort,
      webSearchEnabled: brainConfig.webSearchEnabled
    })) {
      if (turnId !== this.activeTurnId) return;
      if (ev.type === "text") {
        assistantText += ev.text;
        this.sendStream({ type: "text-delta", text: ev.text });
      } else if (ev.type === "thinking") {
        this.sendStream({ type: "thinking-delta", text: ev.text });
      } else if (ev.type === "tool-start") {
        win.webContents.send(IPC.faceState, "thinking");
        this.sendStream({ type: "tool-start", name: ev.name });
      } else if (ev.type === "tool-end") {
        this.sendStream({ type: "tool-end", name: ev.name, isError: ev.isError });
      } else if (ev.type === "tool-image") {
        this.sendStream({ type: "image", dataUrl: ev.dataUrl });
      } else if (ev.type === "error") {
        turnError = ev.message;
        this.sendStream({ type: "error", message: ev.message });
      } else if (ev.type === "turn-done") {
        this.sendStream({ type: "turn-done", fullText: assistantText });
      }
    }

    void log.finish(turnError ? { error: turnError } : { reply: assistantText });
    if (turnId !== this.activeTurnId) return;
    this.runningTurn = false;

    win.webContents.send(IPC.faceState, "idle");
    // Keep only the true conversational history (loop() returns the full
    // tool-augmented transcript internally; we re-derive a compact form so
    // context doesn't balloon with every tool_result on long sessions).
    if (assistantText) {
      this.history.push({ role: "assistant", content: assistantText });
    }
  }

  /** One turn run by Claude Code or OpenCode (engines/): its own tools do the work in the coding
   * folder, and anything that needs an OK comes back here as an approval card. */
  private async runEngine(team: Awaited<ReturnType<typeof loadTeamConfig>>, turnId: number, userText: string, attachments?: Attachment[], vault: string | null = null): Promise<void> {
    const { win } = this.deps;
    const engine = team.engine as "claude-code" | "opencode" | "hermes";
    const abort = new AbortController();
    this.engineAbort = abort;
    this.history.push({ role: "user", content: userText, attachments });
    win.webContents.send(IPC.faceState, "thinking");
    const live = () => turnId === this.activeTurnId;
    const note = attachments?.length ? `\n\n(${attachments.length} attachment${attachments.length === 1 ? "" : "s"} left out: ${engineName(engine)} gets text only here.)` : "";
    const log = new TurnLog(`${engineName(engine)} (${team.engineModels === "team" ? "team's models" : "its own models"})`, userText);
    let reply = "";
    try {
      // Hermes keeps its own conversations: it starts each one knowing what Mimir knows about the user.
      const intro = engine === "hermes" ? await this.engineIntro() : undefined;
      const result = await this.engines.run(team, {
        prompt: userText,
        intro,
        tools: this.engineTools(vault),
        cwd: await codingRoot(),
        projectsRoot: defaultProjectsRoot(),
        approve: async (request) => {
          const allowed = await this.askUser(request);
          log.note(`asked: ${request.title} → ${allowed ? "allowed" : "denied"}`);
          return allowed;
        },
        signal: abort.signal,
        emit: (ev) => {
          if (ev.type === "tool-start") log.note(`tool ${ev.name} started`);
          else if (ev.type === "tool-end") log.note(`tool ${ev.name} ${ev.isError ? "failed" : "finished"}`);
          if (!live()) return;
          if (ev.type === "text") {
            reply += ev.text;
            this.sendStream({ type: "text-delta", text: ev.text });
          } else if (ev.type === "tool-start") this.sendStream({ type: "tool-start", name: ev.name });
          else this.sendStream({ type: "tool-end", name: ev.name, isError: ev.isError });
        }
      });
      reply = result.text || reply;
      void log.finish({ reply });
      if (!live()) return;
      if (note) this.sendStream({ type: "text-delta", text: note });
      this.sendStream({ type: "turn-done", fullText: reply + note });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void log.finish({ error: message });
      if (live()) this.sendStream({ type: "error", message });
    } finally {
      if (reply) this.history.push({ role: "assistant", content: reply });
      if (live()) {
        this.runningTurn = false;
        this.engineAbort = null;
        win.webContents.send(IPC.faceState, "idle");
      }
    }
  }

  /** Mimir's own tools for an outside agent: BridgeDeck's calendar, notes, study, messages and files,
   * its memory, and projects. (The agent brings its own coding and web tools.) */
  private engineTools(vault: string | null) {
    const { workspaceRoot, auditFilePath, semanticSearch } = this.deps;
    const transaction = new SelfEditTransaction(workspaceRoot, auditFilePath);
    const client = bridgeDeckFromEnv();
    const sets = [client ? buildBridgeDeckToolset(client) : { defs: [], handlers: {} }, buildPersonaToolset({ workspaceRoot, transaction }), buildProjectsToolset({ projectsRoot: defaultProjectsRoot(), semanticSearch }), vault ? buildObsidianToolset(vault) : { defs: [], handlers: {} }];
    return { defs: sets.flatMap((s) => s.defs), handlers: Object.assign({}, ...sets.map((s) => s.handlers)) as Record<string, (input: Record<string, unknown>) => Promise<ToolResult>> };
  }

  /** Keeps MEMORY.md and USER.md the same as their copies in the Obsidian vault (and copies the
   * daily logs there). The vault's folder, or null when none is set or it isn't reachable. */
  private async syncVault(): Promise<string | null> {
    const { vault } = await loadObsidianConfig().catch(() => ({ vault: null }));
    if (!vault) return null;
    const { workspaceRoot, auditFilePath } = this.deps;
    try {
      const transaction = new SelfEditTransaction(workspaceRoot, auditFilePath);
      await syncObsidian({
        vault,
        dailyDir: dailyLogDir(workspaceRoot),
        statePath: path.join(path.dirname(workspaceRoot), "obsidian-sync.json"),
        readPersona: (file) => readPersonaFile(workspaceRoot, file),
        writePersona: async (file, text) => {
          await transaction.run({ summary: `${file} edited in Obsidian`, tier: "persona", writes: [{ path: personaRelativePath(file), content: text }], verifySteps: PERSONA_VERIFY_STEPS });
        }
      });
      return vault;
    } catch {
      return null;
    }
  }

  /** What Mimir knows about the user (USER.md) and remembers (MEMORY.md), for an outside agent. */
  private async engineIntro(): Promise<string | undefined> {
    const { user, memory } = await readMemoryFiles(this.deps.workspaceRoot).catch(() => ({ user: "", memory: "" }));
    const parts = [user.trim() && `## About the user\n${user.trim().slice(0, 6000)}`, memory.trim() && `## What Mimir remembers\n${memory.trim().slice(0, 6000)}`].filter(Boolean);
    return parts.length ? `You are working as Mimir, the user's assistant. What Mimir already knows (use it; don't repeat it back):\n\n${parts.join("\n\n")}` : undefined;
  }

  /** Continues a saved chat, or starts a new one for an empty history: those messages become the
   * conversation the model sees from the next message on. */
  openConversation(history: BrainMessage[]): void {
    this.stop();
    this.history = [...history];
    this.stickyModules.clear();
    this.engines.reset();
  }

  /** Ends Claude Code / OpenCode processes (app shutdown). */
  closeEngines(): void {
    this.engines.close();
  }

  /** One turn by the Brain team: the Head plans, the Executor does each step with only that step's
   * tools, the Checker reviews, and the Head writes the reply (team/graph.ts). */
  private async runTeam(args: {
    team: Awaited<ReturnType<typeof loadTeamConfig>>;
    turnId: number;
    userText: string;
    attachments?: Attachment[];
    fullDefs: ToolDef[];
    fullHandlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>>;
    extraModules: PromptModule[];
    dynamicSkillTools: string[];
    effort: Awaited<ReturnType<typeof loadBrainConfig>>["effort"];
  }): Promise<void> {
    const { team, turnId, userText, attachments, fullDefs, extraModules, dynamicSkillTools, effort } = args;
    const { win, workspaceRoot } = this.deps;
    const log = new TurnLog("Brain team", userText);
    const fullHandlers = log.handlers(args.fullHandlers);
    const finish = (error?: string) => {
      if (error) void log.finish({ error });
      if (turnId !== this.activeTurnId) return;
      if (error) this.sendStream({ type: "error", message: error });
      this.runningTurn = false;
      win.webContents.send(IPC.faceState, "idle");
    };

    let roles: Record<"head" | "executor" | "checker", { provider: BrainProvider; endpoint: { provider: string; model: string } }>;
    try {
      const head = await createRoleProvider(team, "head");
      const executor = await createRoleProvider(team, "executor");
      const checker = team.checkerSameAsHead ? head : await createRoleProvider(team, "checker");
      roles = {
        head: { provider: head.provider, endpoint: head.status.endpoint! },
        executor: { provider: executor.provider, endpoint: executor.status.endpoint! },
        checker: { provider: checker.provider, endpoint: checker.status.endpoint! }
      };
    } catch (err) {
      finish(err instanceof Error ? err.message : String(err));
      return;
    }
    if (turnId !== this.activeTurnId) return;

    const tierOf = (role: "head" | "executor" | "checker") => {
      const choice = roleSettings(team, role).tier;
      return choice === "auto" ? resolveToolTier({ kind: roles[role].endpoint.provider, model: roles[role].endpoint.model }) : choice;
    };
    const toolCosts = new Map(fullDefs.map((d) => [d.name, estimateTokens(JSON.stringify(d))]));
    const available = new Set(fullDefs.map((d) => d.name));
    const compose = (role: "head" | "executor" | "checker", modules: string[] | null, text: string) => {
      const cloud = roles[role].endpoint.provider === "anthropic";
      return composeSystemPrompt(workspaceRoot, {
        mode: cloud ? "all" : "lazy",
        toolTier: tierOf(role),
        userText: text,
        force: modules ?? undefined,
        sticky: modules ? undefined : this.stickyModules,
        availableTools: available,
        dynamicSkillTools,
        toolCost: (name) => toolCosts.get(name) ?? 0,
        extraModules,
        ...(cloud ? {} : { memoryMaxChars: LOCAL_MEMORY_INJECT_MAX_CHARS, dailyLogDays: LOCAL_DAILY_LOG_INJECT_DAYS, userMaxChars: LOCAL_USER_INJECT_MAX_CHARS })
      });
    };
    const kitFor = async (role: "head" | "executor" | "checker", modules: string[] | null, text: string): Promise<RoleKit> => {
      const composed = await compose(role, modules, text);
      const allowed = composed.toolNames;
      const offered = (name: string) => (allowed ? allowed.has(name) : true);
      return {
        system: composed.system,
        tools: fullDefs.filter((d) => offered(d.name)),
        handlers: Object.fromEntries(Object.entries(fullHandlers).filter(([name]) => offered(name)))
      };
    };

    // Whether the message needs tools at all decides between one Head call and a plan; the same
    // module loader that trims a single model's prompt answers it.
    const executorTier = tierOf("executor");
    const routing = await compose("executor", null, userText);
    // Only a module that brings tools needs the plan; one that's just text (About, maths notation) doesn't.
    const bringsTools = (id: string) => {
      const m = [...PROMPT_MODULES, ...extraModules].find((x) => x.id === id);
      return !!m && (executorTier === "core" ? m.coreTools : m.tools).length > 0;
    };
    const needsTools = routing.loaded.some((m) => (m.reason === "matched" || m.reason === "sticky") && bringsTools(m.id));
    for (const [id, left] of this.stickyModules) {
      if (left <= 1) this.stickyModules.delete(id);
      else this.stickyModules.set(id, left - 1);
    }
    for (const m of routing.loaded) if (m.reason === "matched") this.stickyModules.set(m.id, STICKY_TURNS);
    const catalog = [...PROMPT_MODULES, ...extraModules].filter((m) => {
      if (m.required || !m.tiers.includes(executorTier)) return false;
      const tools = executorTier === "core" ? m.coreTools : m.tools;
      return tools.length === 0 || tools.some((t) => available.has(t));
    }).map((m) => ({ id: m.id, summary: m.summary }));

    const label = { head: "Head", executor: "Executor", checker: "Checker" } as const;
    const member = (role: "head" | "executor" | "checker"): TeamMember => ({ provider: log.provider(roles[role].provider, label[role]), model: roles[role].endpoint.model });
    const history = [...this.history];
    const message = { role: "user" as const, content: userText, attachments };
    this.history.push(message);
    win.webContents.send(IPC.faceState, "thinking");

    let reply = "";
    const emit = (ev: TeamEvent) => {
      if (turnId !== this.activeTurnId) return;
      if (ev.type === "text") {
        reply += ev.text;
        this.sendStream({ type: "text-delta", text: ev.text });
      } else if (ev.type === "thinking") {
        this.sendStream({ type: "thinking-delta", text: ev.text });
      } else if (ev.type === "plan") {
        log.note(`plan: ${ev.steps.map((step, i) => `${i + 1}. ${step.goal}`).join(" ")}`);
        this.sendStream({ type: "team-plan", steps: ev.steps });
      } else if (ev.type === "step") {
        log.note(`step ${ev.index + 1} ${ev.status} (${ev.role}, ${ev.model})${ev.note ? `: ${ev.note}` : ""}`);
        this.sendStream({ type: "team-step", index: ev.index, status: ev.status, role: ev.role, model: ev.model, note: ev.note });
      }
      else if (ev.type === "tool-start") this.sendStream({ type: "tool-start", name: ev.name, step: ev.step });
      else if (ev.type === "tool-end") this.sendStream({ type: "tool-end", name: ev.name, isError: ev.isError, step: ev.step });
      else if (ev.type === "image") this.sendStream({ type: "image", dataUrl: ev.dataUrl });
      else if (ev.type === "error") this.sendStream({ type: "error", message: ev.message });
    };

    try {
      await runTeamTurn({
        head: member("head"),
        executor: member("executor"),
        checker: member("checker"),
        history,
        message,
        kitFor,
        catalog,
        needsTools,
        checkEachStep: team.checkEachStep,
        emit,
        cancelled: () => turnId !== this.activeTurnId,
        effort
      });
    } catch (err) {
      finish(`The team couldn't finish: ${err instanceof Error ? err.message : String(err)}`);
      if (reply) this.history.push({ role: "assistant", content: reply });
      return;
    }
    void log.finish({ reply });
    if (turnId !== this.activeTurnId) return;
    this.sendStream({ type: "turn-done", fullText: reply });
    finish();
    if (reply) this.history.push({ role: "assistant", content: reply });
  }
}

/** Two tool tiers, never zero tools. "full" is the complete 30-tool surface
 * plus self-edit — every non-Ollama provider, and an Ollama model whose tag
 * parses to more than 7B parameters. "core" is everything else: an Ollama
 * model at 7B or under, AND — this is a deliberate fix, not the original
 * behavior — an Ollama tag with no parseable size at all. Before this fix,
 * "llama3.2" (no explicit size) silently matched neither branch of the old
 * regex and fell through to the FULL toolset, while "llama3.2:3b" — the
 * identical weights — got zero tools. Absence of a size in the tag is not
 * evidence of a large model; treating it as "assume large" was the bug. */
/** Exam mode in BridgeDeck, if it's on (null when it's off or BridgeDeck can't be asked). */
async function examMode(): Promise<{ course: string; until: number } | null> {
  const bridgeDeck = bridgeDeckFromEnv();
  if (!bridgeDeck) return null;
  try {
    const exam = await bridgeDeck.call<{ on: boolean; course?: string; until?: number }>("exam");
    return exam?.on && typeof exam.until === "number" ? { course: exam.course ?? "", until: exam.until } : null;
  } catch {
    return null;
  }
}

export function resolveToolTier(provider: { kind: string; model: string }): "core" | "full" {
  if (provider.kind !== "ollama") return "full";
  const parameterCount = provider.model.match(/(?:^|[:_-])(\d+(?:\.\d+)?)b(?:$|[:_-])/i);
  if (!parameterCount) return "core";
  return Number(parameterCount[1]) > 7 ? "full" : "core";
}

/** Self-edit is the one capability gated a step earlier than the general
 * tier split — it's not just excluded from the core allowlist, its whole
 * toolset is never even constructed for a core-tier turn (see send()).
 * Equivalent to resolveToolTier(provider) === "full"; kept as its own named
 * export since skills/builtins.ts (the Skill Tree UI) checks this
 * specifically to decide whether to show the Self-Edit capability section. */
export function shouldEnableSelfEdit(provider: { kind: string; model: string }): boolean {
  return resolveToolTier(provider) === "full";
}
