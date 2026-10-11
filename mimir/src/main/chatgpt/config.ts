import type { ChatGptConfig } from "../../shared/types.js";
import { readJsonFile, writeJsonFile } from "../config/store.js";
import { getSecret, setSecret } from "../config/keychain.js";

const FILE = "chatgpt.json";
/** Its own keychain entry: the brain's "openai-compatible" key belongs to a VPS. */
const KEY_ACCOUNT = "chatgpt:openai";

type Stored = Omit<ChatGptConfig, "hasApiKey">;

export const DEFAULT_CHATGPT_MODEL = "gpt-5";
const DEFAULTS: Stored = { model: DEFAULT_CHATGPT_MODEL, instructions: "" };

export async function loadChatGptConfig(): Promise<ChatGptConfig> {
  const stored = await readJsonFile<Stored>(FILE, DEFAULTS);
  return { ...stored, hasApiKey: Boolean(await getSecret(KEY_ACCOUNT)) };
}

export async function saveChatGptConfig(patch: Partial<Stored>): Promise<ChatGptConfig> {
  const current = await readJsonFile<Stored>(FILE, DEFAULTS);
  await writeJsonFile(FILE, { ...current, ...patch });
  return loadChatGptConfig();
}

export async function setChatGptApiKey(key: string): Promise<void> {
  await setSecret(KEY_ACCOUNT, key.trim());
}

export function getChatGptApiKey(): Promise<string | null> {
  return getSecret(KEY_ACCOUNT);
}
