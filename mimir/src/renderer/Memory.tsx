import React, { useEffect, useState } from "react";
import type { MemoryFiles } from "../shared/types.js";

/** What Mimir remembers: MEMORY.md (what it saved when asked to remember) and USER.md (about you), both
 * editable. Saves go through the same audited history as Mimir's own memory changes. */
export default function Memory({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<MemoryFiles | null>(null);
  const [memory, setMemory] = useState("");
  const [user, setUser] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.mimir.memory.get().then((f) => {
      setFiles(f);
      setMemory(f.memory);
      setUser(f.user);
    });
  }, []);

  const changed = !!files && (memory !== files.memory || user !== files.user);

  async function save() {
    if (!files) return;
    setSaving(true);
    try {
      const next = await window.mimir.memory.set({ ...(memory !== files.memory ? { memory } : {}), ...(user !== files.user ? { user } : {}) });
      setFiles(next);
      setMemory(next.memory);
      setUser(next.user);
      setStatus({ ok: true, text: "Saved." });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="chatgpt memory-panel">
      <div className="settings-header">
        <h2>Memory</h2>
        <div className="chatgpt-actions">
          <button type="button" className="quick-controls__action" onClick={() => void save()} disabled={!changed || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {!files ? null : (
        <div className="memory-panel__body">
          <p className="hint">
            Mimir reads this before it answers. It adds to it when you ask it to remember something (“remember that…”, “my name is…”, “I
            prefer…”), and you can change it here. Chats are saved separately, under History. Files: {files.folder}
          </p>
          <label className="memory-panel__field">
            <strong>What Mimir remembers</strong>
            <span className="hint">MEMORY.md</span>
            <textarea value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="Nothing yet. Tell Mimir “remember that…” in the chat, or write here." spellCheck />
          </label>
          <label className="memory-panel__field">
            <strong>About you</strong>
            <span className="hint">USER.md</span>
            <textarea value={user} onChange={(e) => setUser(e.target.value)} placeholder="Your name, what you do, how you like answers…" spellCheck />
          </label>
          {status && <p className={`hint${status.ok ? "" : " setup-step__result--error"}`}>{status.text}</p>}
        </div>
      )}
    </div>
  );
}
