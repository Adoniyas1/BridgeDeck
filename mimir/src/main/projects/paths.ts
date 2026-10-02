import os from "node:os";
import path from "node:path";

/**
 * Where your actual work lives — problem sets, lab reports, CAD notes,
 * datasheets you've saved, whatever a project needs. Deliberately NOT
 * inside the self-edit workspace (`<workspace>/`, see
 * src/main/self-edit/workspace.ts) and NOT git-tracked: that workspace is
 * exclusively Mimir's own source + persona, and mixing your files into a
 * repo Mimir rewrites itself in would be a bad idea. This is a plain,
 * visible folder in your own Documents — drag files in or out in Finder,
 * and Mimir can read/write there too via the tools in ./tools.ts.
 */
export function defaultProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  // BridgeDeck points this at its synced Projects folder, so both apps share the same projects.
  const shared = env.MIMIR_PROJECTS_ROOT?.trim();
  if (shared && path.isAbsolute(shared)) return shared;
  return path.join(os.homedir(), "Documents", "Mimir Projects");
}
