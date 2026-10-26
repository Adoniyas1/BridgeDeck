import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MIMIR_HOME } from "../config/store.js";
import type { BrainMessage } from "../brain/Provider.js";
import type { ChatMessage, MimirChat, MimirChatSummary } from "../../shared/types.js";

/** Mimir's own conversations: one JSON file per chat, next to its config (outside the editable workspace). */
export const MIMIR_CHATS_DIR = path.join(MIMIR_HOME, "chats");

const ID = /^[A-Za-z0-9-]{1,64}$/;
const ROLES = new Set(["user", "assistant", "system"]);
/** A saved chat stops growing past this many messages (the oldest go first). */
const MAX_MESSAGES = 500;

function chatFile(dir: string, id: string): string {
  if (!ID.test(id)) throw new Error("Bad chat id");
  return path.join(dir, `${id}.json`);
}

export async function readMimirChat(id: string, dir = MIMIR_CHATS_DIR): Promise<MimirChat | null> {
  try {
    return cleanChat(JSON.parse(await readFile(chatFile(dir, id), "utf-8")));
  } catch {
    return null;
  }
}

/** Saves a chat from the renderer; returns what was saved (cleaned), or null when there's nothing to keep. */
export async function writeMimirChat(raw: unknown, dir = MIMIR_CHATS_DIR): Promise<MimirChat | null> {
  const chat = cleanChat(raw);
  // A chat with no message from the user (just the greeting) isn't worth a file.
  if (!chat || !chat.messages.some((m) => m.role === "user")) return null;
  await mkdir(dir, { recursive: true });
  await writeFile(chatFile(dir, chat.id), JSON.stringify(chat, null, 2), "utf-8");
  return chat;
}

export async function deleteMimirChat(id: string, dir = MIMIR_CHATS_DIR): Promise<void> {
  await rm(chatFile(dir, id), { force: true });
}

/** Most recently used first. */
export async function listMimirChats(dir = MIMIR_CHATS_DIR): Promise<MimirChatSummary[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const chats = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => readMimirChat(n.slice(0, -5), dir)));
  return chats
    .filter((c): c is MimirChat => c !== null)
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A chat as the model should continue it: the user's messages and Mimir's replies, as text. Thinking,
 * plans and error notes stay on screen only. */
export function historyFromChat(chat: MimirChat): BrainMessage[] {
  const history: BrainMessage[] = [];
  for (const m of chat.messages) {
    if (m.role === "system" || !m.text.trim()) continue;
    // A conversation starts with the user (the greeting before it isn't part of it).
    if (!history.length && m.role !== "user") continue;
    history.push({ role: m.role, content: m.text });
  }
  return history;
}

/** Checks a chat that came from the renderer or disk, keeping only the fields Mimir uses. */
export function cleanChat(raw: unknown): MimirChat | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || !ID.test(c.id) || !Array.isArray(c.messages)) return null;
  const messages: ChatMessage[] = [];
  for (const item of c.messages.slice(-MAX_MESSAGES)) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.role !== "string" || !ROLES.has(m.role) || typeof m.text !== "string") continue;
    messages.push({
      id: typeof m.id === "string" ? m.id : `${messages.length}`,
      role: m.role as ChatMessage["role"],
      text: m.text,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
      ...(m.team && typeof m.team === "object" ? { team: m.team as ChatMessage["team"] } : {}),
      ...(typeof m.thinking === "string" && m.thinking ? { thinking: m.thinking } : {}),
      ...(typeof m.thinkingMs === "number" ? { thinkingMs: m.thinkingMs } : {})
    });
  }
  const firstQuestion = messages.find((m) => m.role === "user")?.text ?? "";
  const now = Date.now();
  return {
    id: c.id,
    title: typeof c.title === "string" && c.title.trim() ? c.title.trim().slice(0, 80) : titleFrom(firstQuestion),
    messages,
    createdAt: typeof c.createdAt === "number" ? c.createdAt : now,
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : now
  };
}

/** A chat's title: its first message, cut to one short line. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "New chat";
}
