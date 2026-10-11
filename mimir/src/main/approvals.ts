import type { ToolApproval } from "../shared/types.js";

/** Asks the user to allow one tool call; resolves true when they allow it. Every tool that runs a
 * command or changes something outside the Projects folder goes through one of these. */
export type Approver = (request: Omit<ToolApproval, "id">) => Promise<boolean>;

/** For places with no one to ask (background passes, listings): always no. */
export const denyAll: Approver = async () => false;

/** Shortens a long argument for an approval card. */
export function preview(value: unknown, max = 1500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}
