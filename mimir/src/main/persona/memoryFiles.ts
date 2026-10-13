import { readFile } from "node:fs/promises";
import type { MemoryFiles } from "../../shared/types.js";
import type { SelfEditTransaction } from "../self-edit/transaction.js";
import { PERSONA_VERIFY_STEPS } from "../self-edit/verifyPresets.js";
import { personaDir, personaFilePath, personaRelativePath } from "./paths.js";
import { MEMORY_FILE_MAX_BYTES, PERSONA_MARKDOWN_MAX_BYTES } from "./templates.js";

/** What Mimir remembers (MEMORY.md) and knows about the user (USER.md), for the Memory panel. */
export async function readMemoryFiles(workspaceRoot: string): Promise<MemoryFiles> {
  const read = (file: string) => readFile(personaFilePath(workspaceRoot, file), "utf-8").catch(() => "");
  const [memory, user] = await Promise.all([read("MEMORY.md"), read("USER.md")]);
  return { memory, user, folder: personaDir(workspaceRoot) };
}

/** Saves the user's edits from the Memory panel, through the same audited transaction as Mimir's own
 * memory tools, so an edit can be undone from the audit log like any other change. */
export async function writeMemoryFiles(workspaceRoot: string, transaction: SelfEditTransaction, patch: { memory?: string; user?: string }): Promise<MemoryFiles> {
  const writes: Array<{ path: string; content: string }> = [];
  const add = (file: string, text: string | undefined, max: number) => {
    if (typeof text !== "string") return;
    if (Buffer.byteLength(text, "utf-8") > max) throw new Error(`${file} is over its ${Math.round(max / 1000)} KB limit.`);
    writes.push({ path: personaRelativePath(file), content: text });
  };
  add("MEMORY.md", patch.memory, MEMORY_FILE_MAX_BYTES);
  add("USER.md", patch.user, PERSONA_MARKDOWN_MAX_BYTES);
  if (writes.length) {
    const result = await transaction.run({ summary: "Memory edited in the Memory panel", tier: "persona", writes, verifySteps: PERSONA_VERIFY_STEPS });
    if (result.status === "rejected") throw new Error(`Couldn't save: ${result.detail}`);
    if (result.status !== "applied") throw new Error(`Couldn't save: ${result.stepOutput}`);
  }
  return readMemoryFiles(workspaceRoot);
}
