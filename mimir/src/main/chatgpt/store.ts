import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MIMIR_HOME } from "../config/store.js";
import type { ChatGptChat, ChatGptChatSummary } from "../../shared/types.js";

/** One JSON file per chat, kept with Mimir's config (outside the editable workspace). */
export const DEFAULT_CHATS_DIR = path.join(MIMIR_HOME, "chatgpt");

const ID = /^[A-Za-z0-9-]{1,64}$/;

function chatFile(dir: string, id: string): string {
  if (!ID.test(id)) throw new Error("Bad chat id");
  return path.join(dir, `${id}.json`);
}

export async function readChat(id: string, dir = DEFAULT_CHATS_DIR): Promise<ChatGptChat | null> {
  try {
    return JSON.parse(await readFile(chatFile(dir, id), "utf-8")) as ChatGptChat;
  } catch {
    return null;
  }
}

export async function writeChat(chat: ChatGptChat, dir = DEFAULT_CHATS_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(chatFile(dir, chat.id), JSON.stringify(chat, null, 2), "utf-8");
}

export async function deleteChat(id: string, dir = DEFAULT_CHATS_DIR): Promise<void> {
  await rm(chatFile(dir, id), { force: true });
}

/** Most recently used first. */
export async function listChats(dir = DEFAULT_CHATS_DIR): Promise<ChatGptChatSummary[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const chats = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => readChat(n.slice(0, -5), dir)));
  return chats
    .filter((c): c is ChatGptChat => c !== null)
    .map(({ id, title, model, updatedAt }) => ({ id, title, model, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A chat's name: its first question, shortened. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "New chat";
}

export function chatToMarkdown(chat: ChatGptChat): string {
  return chat.messages
    .map((m) => `### ${m.role === "user" ? "You" : "ChatGPT"}\n\n${m.content.trim()}`)
    .join("\n\n");
}
