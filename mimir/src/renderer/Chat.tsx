import React, { useEffect, useRef, useState } from "react";
import MessageContent from "./MessageContent.js";
import CameraCapture from "./camera/CameraCapture.js";
import type { ChatMessage, LoadedPromptModule, MimirChatSummary, PendingEdit, TeamProgress, ToolApproval } from "../shared/types.js";

interface ChatProps {
  messages: ChatMessage[];
  /** The conversation on screen (saved in ~/.mimir/chats). */
  chatId: string;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onOpenMemory: () => void;
  /** Whether local models think before answering (Brain team setting). */
  thinkingOn: boolean;
  onToggleThinking: () => void;
  pendingEdit: PendingEdit | null;
  /** Tool calls waiting for the user's OK. */
  approvals: ToolApproval[];
  onDecide: (id: string, allow: boolean) => void;
  busy: boolean;
  openMicEnabled: boolean;
  /** What was loaded into the model for the latest message. */
  context: { modules: LoadedPromptModule[]; tokens: number } | null;
  onSend: (text: string, files?: File[]) => void;
  onStop: () => void;
  onApprove: () => void;
  onReject: () => void;
  onOpenMicToggle: () => void;
}

export default function Chat({
  messages,
  chatId,
  onNewChat,
  onOpenChat,
  onOpenMemory,
  thinkingOn,
  onToggleThinking,
  pendingEdit,
  approvals,
  onDecide,
  busy,
  openMicEnabled,
  context,
  onSend,
  onStop,
  onApprove,
  onReject,
  onOpenMicToggle
}: ChatProps) {
  const [draft, setDraft] = useState("");
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [history, setHistory] = useState<MimirChatSummary[] | null>(null);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  async function toggleHistory() {
    setHistory(history ? null : await window.mimir.chats.list());
  }

  async function removeChat(id: string) {
    await window.mimir.chats.remove(id);
    if (id === chatId) onNewChat();
    setHistory(await window.mimir.chats.list());
  }
  const fileInput = useRef<HTMLInputElement>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if ((!text && stagedFiles.length === 0) || busy) return;
    onSend(text, stagedFiles.length > 0 ? stagedFiles : undefined);
    setDraft("");
    setStagedFiles([]);
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    setStagedFiles((prev) => [...prev, ...Array.from(files)]);
  }

  function removeStagedFile(index: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="chat">
      {showCamera && (
        <CameraCapture
          onCapture={(file) => {
            setStagedFiles((prev) => [...prev, file]);
            setShowCamera(false);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}
      <div className="chat-console-heading">
        <span>Conversation</span>
        <span className="chat-heading-actions">
          <button
            type="button"
            className={`chat-chip${thinkingOn ? " chat-chip--on" : ""}`}
            onClick={onToggleThinking}
            title="Let local models think before answering, and show their thinking above each reply (slower). Claude always thinks; its thinking shows either way."
          >
            Thinking {thinkingOn ? "on" : "off"}
          </button>
          <button type="button" className="chat-chip" onClick={onOpenMemory} title="What Mimir remembers about you">
            Memory
          </button>
          <button type="button" className={`chat-chip${history ? " chat-chip--on" : ""}`} onClick={() => void toggleHistory()} title="Saved chats">
            History
          </button>
          <button
            type="button"
            className="chat-chip"
            onClick={() => {
              setHistory(null);
              onNewChat();
            }}
            title="Start a new chat (this one stays in History)"
          >
            New
          </button>
          <span className={busy ? "chat-state chat-state--busy" : "chat-state"}>{busy ? "Working" : "Ready"}</span>
        </span>
      </div>
      {history && (
        <nav className="chat-history" aria-label="Saved chats">
          {history.length === 0 && <p className="hint">No saved chats yet. Each chat is saved after Mimir replies.</p>}
          {history.map((c) => (
            <div key={c.id} className={`chat-history__item${c.id === chatId ? " chat-history__item--active" : ""}`}>
              <button
                type="button"
                className="chat-history__open"
                onClick={() => {
                  setHistory(null);
                  onOpenChat(c.id);
                }}
              >
                <span>{c.title}</span>
                <small>{new Date(c.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small>
              </button>
              <button type="button" className="chat-history__delete" onClick={() => void removeChat(c.id)} aria-label={`Delete ${c.title}`} title="Delete">
                ×
              </button>
            </div>
          ))}
        </nav>
      )}
      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-bubble chat-bubble--${m.role}`}>
            <span className="chat-role">{m.role === "user" ? "You" : m.role === "assistant" ? "Mimir" : "System"}</span>
            {m.thinking && <Thinking text={m.thinking} ms={m.thinkingMs} live={busy && m.id === lastAssistant && !m.text} />}
            {m.team && <TeamCard team={m.team} />}
            <div className="chat-text">
              {m.text ? (
                <MessageContent text={m.text} />
              ) : busy && m.role === "assistant" && !m.thinking ? (
                <span className="typing" aria-label="Mimir is thinking">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                ""
              )}
            </div>
          </div>
        ))}
        {approvals.map((a) => (
          <div key={a.id} className="edit-card approval-card">
            <div className="edit-card-title">{a.title}</div>
            <div className="edit-card-files">{a.tool}</div>
            {a.detail && <pre className="edit-card-diff">{a.detail}</pre>}
            <div className="edit-card-actions">
              <button type="button" onClick={() => onDecide(a.id, true)} className="btn btn--approve">
                Allow
              </button>
              <button type="button" onClick={() => onDecide(a.id, false)} className="btn btn--reject">
                Deny
              </button>
            </div>
          </div>
        ))}
        {pendingEdit && (
          <div className="edit-card">
            <div className="edit-card-title">
              Mimir wants to change its own {pendingEdit.tier === "core" ? "core code" : "skills"}
            </div>
            <div className="edit-card-summary">{pendingEdit.summary}</div>
            <div className="edit-card-files">{pendingEdit.filesTouched.join(", ")}</div>
            <pre className="edit-card-diff">{pendingEdit.diff.slice(0, 4000)}</pre>
            <div className="edit-card-actions">
              <button type="button" onClick={onApprove} className="btn btn--approve">
                Approve
              </button>
              <button type="button" onClick={onReject} className="btn btn--reject">
                Reject
              </button>
            </div>
          </div>
        )}
      </div>

      {context && context.modules.length > 0 && (
        <div className="context-chips" title="Prompt modules sent to the model with your last message. See Skills → What gets loaded.">
          <span>Loaded:</span>
          {context.modules.map((m) => (
            <span key={m.id} className={`context-chip context-chip--${m.reason}`}>
              {m.title}
            </span>
          ))}
          <span className="context-chips__size">~{context.tokens} tokens</span>
        </div>
      )}

      {stagedFiles.length > 0 && (
        <div className="attachment-chips">
          {stagedFiles.map((file, i) => (
            <span key={`${file.name}-${i}`} className="attachment-chip">
              {file.name}
              <button
                type="button"
                onClick={() => removeStagedFile(i)}
                aria-label={`Remove ${file.name}`}
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <form className="chat-input" onSubmit={submit}>
        <span className="chat-input__glow" aria-hidden="true" />
        <button
          type="button"
          className={`voice-control ${openMicEnabled ? "voice-control--active" : ""}`}
          onClick={onOpenMicToggle}
          aria-label={openMicEnabled ? "Pause Open Mic" : "Enable Open Mic"}
          title={openMicEnabled ? "Pause Open Mic" : "Enable Open Mic"}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Zm-7 9a7 7 0 0 0 14 0M12 19v2" /></svg>
        </button>
        <button
          type="button"
          className="voice-control"
          onClick={() => fileInput.current?.click()}
          aria-label="Attach a file"
          title="Attach a photo, PDF, or file"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" /></svg>
        </button>
        <button
          type="button"
          className="voice-control"
          onClick={() => setShowCamera(true)}
          aria-label="Take a photo with the camera"
          title="Take a photo with the camera"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="image/*,application/pdf,text/*,.md,.py,.ts,.tsx,.js,.jsx,.json,.csv,.c,.cpp,.h,.java,.m,.rs,.go,.sh,.yaml,.yml,.toml,.ini"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask Mimir anything…"
          disabled={busy}
        />
        {busy && (
          <button type="button" className="voice-control voice-control--stop" onClick={onStop} aria-label="Stop Mimir" title="Stop Mimir">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
          </button>
        )}
        <button type="submit" disabled={busy || (!draft.trim() && stagedFiles.length === 0)} className="btn send-button" aria-label="Send" title="Send">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </form>
    </div>
  );
}

/** The model's thinking before its reply: open while it thinks, folded once the reply starts. */
function Thinking({ text, ms, live }: { text: string; ms?: number; live: boolean }) {
  const [open, setOpen] = useState(live);
  const [wasLive, setWasLive] = useState(live);
  // Opens while thinking streams in, folds itself when the answer begins (the user can open it again).
  if (live !== wasLive) {
    setWasLive(live);
    setOpen(live);
  }
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) end.current?.scrollIntoView({ block: "nearest" });
  }, [text, live]);
  const label = live ? "Thinking…" : ms !== undefined ? `Thought for ${Math.max(1, Math.round(ms / 1000))}s` : "Thoughts";
  return (
    <details className={`thinking${live ? " thinking--live" : ""}`} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{label}</summary>
      <div className="thinking__text">
        {text.trim()}
        <div ref={end} />
      </div>
    </details>
  );
}

const STEP_LABEL: Record<TeamProgress["steps"][number]["status"], string> = {
  waiting: "Waiting",
  running: "Working",
  checking: "Checking",
  passed: "Done",
  retry: "Sent back",
  failed: "Didn't pass",
  head: "Head is doing it"
};

/** The Brain team's plan for this reply: each step, who is on it and how it went. */
function TeamCard({ team }: { team: TeamProgress }) {
  const done = team.steps.filter((s) => s.status === "passed").length;
  const working = team.steps.some((s) => s.status === "running" || s.status === "checking" || s.status === "head");
  return (
    <details className="team-card" open={working || undefined}>
      <summary>
        Plan · {done}/{team.steps.length} steps done
      </summary>
      <ol>
        {team.steps.map((s, i) => (
          <li key={i} className={`team-step team-step--${s.status}`}>
            <span className="team-step__goal">{s.goal}</span>
            <span className="team-step__meta">
              {STEP_LABEL[s.status]}
              {s.model && ` · ${s.model}`}
              {s.tools.length > 0 && ` · ${[...new Set(s.tools)].join(", ")}`}
            </span>
            {s.note && <span className="team-step__note">{s.note}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}
