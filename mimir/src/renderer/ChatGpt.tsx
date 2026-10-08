import React, { useEffect, useRef, useState } from "react";
import MessageContent from "./MessageContent.js";
import type { ChatGptChat, ChatGptChatSummary, ChatGptConfig } from "../shared/types.js";

/**
 * The ChatGPT section: OpenAI's models with the user's own API key, in chats of
 * their own (kept in ~/.mimir/chatgpt). Separate from Mimir's brain: ChatGPT
 * here has no tools and can't change anything; "Save to Notes" is the user's.
 */
export default function ChatGpt({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<ChatGptConfig | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [chats, setChats] = useState<ChatGptChatSummary[]>([]);
  const [chat, setChat] = useState<ChatGptChat | null>(null);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const chatIdRef = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.mimir.chatgpt.getConfig().then((cfg) => {
      setConfig(cfg);
      if (cfg.hasApiKey) void loadModels();
    });
    void refreshChats();
    return window.mimir.chatgpt.onStream((event) => {
      if (event.chatId !== chatIdRef.current) {
        if (event.type === "done") void refreshChats();
        return;
      }
      if (event.type === "text-delta") setStreaming((prev) => (prev ?? "") + event.text);
      else if (event.type === "error") setNotice(`⚠️ ${event.message}`);
      else {
        setChat(event.chat);
        setStreaming(null);
        void refreshChats();
      }
    });
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [chat, streaming]);

  async function refreshChats() {
    setChats(await window.mimir.chatgpt.listChats());
  }

  async function loadModels() {
    try {
      setModels(await window.mimir.chatgpt.listModels());
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  function openChat(next: ChatGptChat | null) {
    chatIdRef.current = next?.id ?? null;
    setChat(next);
    setStreaming(null);
    setNotice(null);
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    const next = await window.mimir.chatgpt.setApiKey(keyInput);
    setKeyInput("");
    setConfig(next);
    setShowSetup(false);
    void loadModels();
  }

  async function patch(p: Partial<Omit<ChatGptConfig, "hasApiKey">>) {
    setConfig(await window.mimir.chatgpt.setConfig(p));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || streaming !== null || !config) return;
    setDraft("");
    setNotice(null);
    setStreaming("");
    // A new chat's id is chosen here so the reply's events (which can beat send's answer) match it.
    const id = chat?.id ?? crypto.randomUUID();
    chatIdRef.current = id;
    try {
      const updated = await window.mimir.chatgpt.send(id, text, chat ? undefined : config.model);
      // The reply may already be finished (and shown) by now; only fill in a chat still in progress.
      setChat((current) => (current && current.id === id && current.messages.length >= updated.messages.length ? current : updated));
      void refreshChats();
    } catch (error) {
      if (!chat) chatIdRef.current = null;
      setStreaming(null);
      setDraft(text);
      setNotice(errorText(error));
    }
  }

  async function saveToNotes() {
    if (!chat) return;
    try {
      await window.mimir.chatgpt.saveToNotes(chat.id);
      setNotice(chat.noteId ? "Updated the note in Notes → ChatGPT." : "Saved to Notes → ChatGPT.");
      const fresh = await window.mimir.chatgpt.getChat(chat.id);
      if (fresh && chatIdRef.current === fresh.id && streaming === null) setChat(fresh);
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  async function remove(id: string) {
    await window.mimir.chatgpt.deleteChat(id);
    if (chatIdRef.current === id) openChat(null);
    void refreshChats();
  }

  if (!config) return <div className="settings">Loading…</div>;

  const modelOptions = models.includes(config.model) ? models : [config.model, ...models];
  const busy = streaming !== null;

  return (
    <div className="chatgpt">
      <div className="settings-header">
        <h2>ChatGPT</h2>
        <div className="chatgpt-actions">
          {config.hasApiKey && (
            <select
              className="quick-controls__model"
              value={chat?.model ?? config.model}
              disabled={!!chat}
              onChange={(e) => void patch({ model: e.target.value })}
              title={chat ? "This chat's model (start a new chat to change it)" : "Model for new chats"}
              aria-label="ChatGPT model"
            >
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="quick-controls__action" onClick={() => openChat(null)} disabled={busy}>
            NEW
          </button>
          <button type="button" className="quick-controls__action" onClick={() => void saveToNotes()} disabled={!chat || busy}>
            SAVE TO NOTES
          </button>
          <button type="button" className="quick-controls__action" onClick={() => setShowSetup((s) => !s)}>
            KEY
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {(!config.hasApiKey || showSetup) && (
        <section className="chatgpt-setup">
          <p className="hint">
            Uses your own OpenAI API key (platform.openai.com → API keys), kept in this computer's keychain. API use is
            billed by OpenAI separately from a ChatGPT Plus plan. To use your ChatGPT account instead, BridgeDeck's ChatGPT
            panel (⌘/Ctrl+J) opens chatgpt.com.
          </p>
          <div className="key-row">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveKey();
              }}
              placeholder={config.hasApiKey ? "Saved. Paste a new key to replace it" : "sk-..."}
            />
            <button type="button" className="btn" onClick={() => void saveKey()}>
              Save
            </button>
          </div>
          <label>
            Instructions for every chat (optional)
            <textarea
              rows={3}
              defaultValue={config.instructions}
              onBlur={(e) => void patch({ instructions: e.target.value })}
              placeholder="e.g. I'm a student; explain step by step."
            />
          </label>
        </section>
      )}

      <div className="chatgpt-body">
        <nav className="chatgpt-list" aria-label="ChatGPT chats">
          {chats.length === 0 && <p className="hint">No chats yet.</p>}
          {chats.map((c) => (
            <div key={c.id} className={`chatgpt-list__item ${chat?.id === c.id ? "chatgpt-list__item--active" : ""}`}>
              <button
                type="button"
                onClick={() => void window.mimir.chatgpt.getChat(c.id).then(openChat)}
                disabled={busy}
                title={c.title}
              >
                {c.title}
              </button>
              <button type="button" className="chatgpt-list__delete" onClick={() => void remove(c.id)} aria-label={`Delete ${c.title}`} title="Delete">
                ×
              </button>
            </div>
          ))}
        </nav>

        <div className="chat">
          <div className="chat-messages">
            {!chat && streaming === null && <p className="hint">Ask ChatGPT anything. Chats are kept here until you delete them.</p>}
            {chat?.messages.map((m, i) => (
              <div key={i} className={`chat-bubble chat-bubble--${m.role}`}>
                <span className="chat-role">{m.role === "user" ? "You" : "ChatGPT"}</span>
                <div className="chat-text">
                  <MessageContent text={m.content} />
                </div>
              </div>
            ))}
            {streaming !== null && (
              <div className="chat-bubble chat-bubble--assistant">
                <span className="chat-role">ChatGPT</span>
                <div className="chat-text">
                  {streaming ? (
                    <MessageContent text={streaming} />
                  ) : (
                    <span className="typing" aria-label="ChatGPT is writing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              </div>
            )}
            {notice && <div className="chat-bubble chat-bubble--system">{notice}</div>}
            <div ref={bottom} />
          </div>

          <form className="chat-input" onSubmit={(e) => void submit(e)}>
            <span className="chat-input__glow" aria-hidden="true" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={config.hasApiKey ? "Message ChatGPT…" : "Add your OpenAI API key above first"}
              disabled={!config.hasApiKey || busy}
            />
            {busy && chat && (
              <button
                type="button"
                className="voice-control voice-control--stop"
                onClick={() => window.mimir.chatgpt.stop(chat.id)}
                aria-label="Stop ChatGPT"
                title="Stop"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
              </button>
            )}
            <button type="submit" disabled={busy || !draft.trim() || !config.hasApiKey} className="btn send-button" aria-label="Send" title="Send">
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function errorText(error: unknown): string {
  return `⚠️ ${error instanceof Error ? error.message : String(error)}`;
}
