import { createBrainProvider } from "../brain/index.js";
import { shouldEnableSelfEdit } from "../agent/session.js";
import { buildSelfEditToolset } from "../self-edit/tools.js";
import { SelfEditTransaction } from "../self-edit/transaction.js";
import { buildPersonaToolset } from "../persona/tools.js";
import { buildProjectsToolset } from "../projects/tools.js";
import { buildComputeToolset } from "../compute/tools.js";
import { buildSkillsToolset } from "./tools.js";
import { defaultProjectsRoot } from "../projects/paths.js";
import { defaultSkillsRoot } from "./paths.js";
import { buildMacToolset, openWithMac } from "../mac/tools.js";
import { buildEngineeringToolset, runCalculiX, runFreeCadMacro, runKicadDrc, runKicadErc, runNgspice } from "../engineering/tools.js";
import { buildEngineeringWorkflowToolset } from "../engineering/workflow.js";
import { buildWebToolset } from "../web/tools.js";
import { buildCodingToolset } from "../coding/tools.js";
import { denyAll } from "../approvals.js";
import { estimateTokens } from "../prompts/loader.js";
import { moduleForTool, PROMPT_MODULES } from "../prompts/modules.js";
import type { ToolDef } from "../brain/Provider.js";
import type { PromptModuleInfo } from "../../shared/types.js";

export type { BuiltInCapability } from "../../shared/types.js";
import type { BuiltInCapability } from "../../shared/types.js";

/**
 * Every tool the current model has natively — not something it taught
 * itself via create_skill, just always there. Shown in the Skill Tree
 * alongside self-taught skills so "what can this AI actually do" is the
 * whole picture, not just the part it built for itself. Reuses the exact
 * same build*Toolset() functions session.ts wires into a real
 * conversation, so this list can never drift from what's actually offered
 * — the dependencies passed in are stubs (never invoked, this only reads
 * .defs) since listing tools doesn't need to run any of them.
 */
export async function listBuiltInCapabilities(workspaceRoot: string, auditFilePath: string): Promise<BuiltInCapability[]> {
  const defs = await collectToolDefs(workspaceRoot, auditFilePath);
  const capabilities: BuiltInCapability[] = defs.map((d) => {
    const owner = moduleForTool(d.name);
    return { name: d.name, description: d.description, category: owner?.title ?? "Other", module: owner?.id ?? "" };
  });

  // Self-edit depends on which model is actually configured right now (see
  // shouldEnableSelfEdit) — no provider configured yet, or a provider that
  // can't be reached, just means this section is empty, not an error.
  try {
    const provider = await createBrainProvider();
    if (shouldEnableSelfEdit(provider)) {
      const selfEdit = buildSelfEditToolset({
        workspaceRoot,
        transaction: new SelfEditTransaction(workspaceRoot, auditFilePath),
        gate: { requestApproval: async () => "rejected" },
        getAutoApproveCoreEdits: async () => false
      });
      const owner = moduleForTool("propose_edit");
      capabilities.push(...selfEdit.defs.map((d) => ({ name: d.name, description: d.description, category: owner?.title ?? "Self-editing", module: owner?.id ?? "" })));
    }
  } catch {
    // No usable provider — self-edit section just doesn't appear.
  }

  return capabilities;
}

/**
 * The prompt modules Mimir loads, for the Skills view: what each is for, when
 * it loads, which tools it brings and roughly how many tokens it costs a
 * small model (prompt text plus tool schemas). BridgeDeck's own tools are only
 * known when BridgeDeck started Mimir, so they are sized by name only.
 */
export async function listPromptModules(workspaceRoot: string, auditFilePath: string): Promise<PromptModuleInfo[]> {
  const defs = await collectToolDefs(workspaceRoot, auditFilePath);
  const selfEdit = buildSelfEditToolset({
    workspaceRoot,
    transaction: new SelfEditTransaction(workspaceRoot, auditFilePath),
    gate: { requestApproval: async () => "rejected" },
    getAutoApproveCoreEdits: async () => false
  });
  const cost = new Map([...defs, ...selfEdit.defs].map((d) => [d.name, estimateTokens(JSON.stringify(d))]));
  return PROMPT_MODULES.map((m) => {
    const text = estimateTokens(m.coreText ?? m.text);
    return {
      id: m.id,
      title: m.title,
      summary: m.summary,
      when: m.when,
      required: m.required,
      tiers: m.tiers,
      tools: m.tools,
      coreTools: m.coreTools,
      coreTokens: text + m.coreTools.reduce((sum, t) => sum + (cost.get(t) ?? 0), 0),
      fullTokens: estimateTokens(m.text) + m.tools.reduce((sum, t) => sum + (cost.get(t) ?? 0), 0)
    };
  });
}

async function collectToolDefs(workspaceRoot: string, auditFilePath: string): Promise<ToolDef[]> {
  const transaction = new SelfEditTransaction(workspaceRoot, auditFilePath);
  const noRunPython = async () => ({ stdout: "", result: null, error: "Not available outside a real conversation." });

  const persona = buildPersonaToolset({ workspaceRoot, transaction });
  const projects = buildProjectsToolset({ projectsRoot: defaultProjectsRoot(), semanticSearch: async () => [] });
  const compute = buildComputeToolset({ runPython: noRunPython, resetPython: () => undefined });
  const skillsMeta = buildSkillsToolset({ skillsRoot: defaultSkillsRoot(), runPython: noRunPython });
  const mac = buildMacToolset({ projectsRoot: defaultProjectsRoot(), open: openWithMac });
  const engineering = buildEngineeringToolset({ projectsRoot: defaultProjectsRoot(), runFreeCad: runFreeCadMacro, runCalculiX, runNgspice, runKicadErc, runKicadDrc });
  const workflow = buildEngineeringWorkflowToolset(defaultProjectsRoot());
  const web = buildWebToolset();
  const coding = buildCodingToolset({ root: defaultProjectsRoot(), projectsRoot: defaultProjectsRoot(), approve: denyAll });
  return [...coding.defs, ...persona.defs, ...projects.defs, ...compute.defs, ...skillsMeta.defs, ...mac.defs, ...engineering.defs, ...workflow.defs, ...web.defs];
}
