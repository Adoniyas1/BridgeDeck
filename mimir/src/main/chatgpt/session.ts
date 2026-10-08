import { IPC, type ChatGptChat, type ChatGptStreamEvent } from "../../shared/types.js";
import type { BridgeDeckClient } from "../bridgedeck/client.js";
import { streamChatGpt } from "./client.js";
import { getChatGptApiKey, loadChatGptConfig } from "./config.js";
import { chatToMarkdown, DEFAULT_CHATS_DIR, readChat, titleFrom, writeChat } from "./store.js";

export interface ChatGptSessionOptions {
  broadcast: (ch: string, event: ChatGptStreamEvent) => void;
  dir?: string;
  fetchImpl?: typeof fetch;
}

/** Runs ChatGPT replies (one at a time per chat) and keeps each chat on disk. */
export class ChatGptSession {
  private running = new Map<string, AbortController>();
  private dir: string;

  constructor(private opts: ChatGptSessionOptions) {
    this.dir = opts.dir ?? DEFAULT_CHATS_DIR;
  }

  /** Adds the user's message and starts the reply; returns the chat as it is now. The page picks a
   * new chat's id, so it can match the reply's events to it before this returns. */
  async send(chatId: string, text: string, model?: string): Promise<ChatGptChat> {
    const config = await loadChatGptConfig();
    const apiKey = await getChatGptApiKey();
    if (!apiKey) throw new Error("Add your OpenAI API key first.");
    const now = Date.now();
    const existing = await readChat(chatId, this.dir);
    if (existing && this.running.has(existing.id)) throw new Error("ChatGPT is still answering in this chat.");
    const chat: ChatGptChat = existing ?? {
      id: chatId,
      title: titleFrom(text),
      model: model || config.model,
      messages: [],
      createdAt: now,
      updatedAt: now,
      noteId: null
    };
    if (model && !existing) chat.model = model;
    chat.messages.push({ role: "user", content: text });
    chat.updatedAt = now;
    await writeChat(chat, this.dir);
    void this.reply(chat, apiKey, config.instructions);
    return chat;
  }

  stop(chatId: string): void {
    this.running.get(chatId)?.abort();
  }

  private async reply(chat: ChatGptChat, apiKey: string, instructions: string): Promise<void> {
    const controller = new AbortController();
    this.running.set(chat.id, controller);
    let text = "";
    let failure: string | null = null;
    try {
      for await (const delta of streamChatGpt({
        apiKey,
        model: chat.model,
        instructions,
        messages: chat.messages,
        signal: controller.signal,
        fetchImpl: this.opts.fetchImpl
      })) {
        text += delta;
        this.opts.broadcast(IPC.chatgptStream, { type: "text-delta", chatId: chat.id, text: delta });
      }
    } catch (error) {
      if (!controller.signal.aborted) failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.running.delete(chat.id);
    }
    // A stopped reply keeps what had arrived, like ChatGPT does.
    if (text) {
      chat.messages.push({ role: "assistant", content: text });
      chat.updatedAt = Date.now();
      await writeChat(chat, this.dir);
    }
    if (failure) this.opts.broadcast(IPC.chatgptStream, { type: "error", chatId: chat.id, message: failure });
    this.opts.broadcast(IPC.chatgptStream, { type: "done", chatId: chat.id, chat });
  }

  /** Saves the chat as a note in BridgeDeck's "ChatGPT" folder; saving again rewrites that note. */
  async saveToNotes(chatId: string, client: BridgeDeckClient | null): Promise<{ noteId: string }> {
    if (!client) throw new Error("Saving to Notes works when Mimir runs inside BridgeDeck.");
    const chat = await readChat(chatId, this.dir);
    if (!chat) throw new Error("That chat no longer exists.");
    const markdown = chatToMarkdown(chat);
    if (chat.noteId) {
      try {
        await client.call("notes/replace", { id: chat.noteId, markdown });
        return { noteId: chat.noteId };
      } catch (error) {
        // The note was deleted in Notes: make a new one below.
        if (!String(error instanceof Error ? error.message : error).includes("No such note")) throw error;
      }
    }
    const created = await client.call<{ id: string }>("notes/create", { title: chat.title, folder: "ChatGPT", markdown });
    chat.noteId = created.id;
    await writeChat(chat, this.dir);
    return { noteId: created.id };
  }
}
