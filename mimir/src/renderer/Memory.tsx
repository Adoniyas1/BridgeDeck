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
  const [vault, setVault] = useState("");
  const [vaultNote, setVaultNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [useBridgeDeck, setUseBridgeDeck] = useState(true);
  const [bridgedeck, setBridgeDeck] = useState<{ enabled: boolean; path: string } | null>(null);
  useEffect(() => {
    void window.mimir.memory.obsidian().then((c) => {
      setVault(c.vault ?? "");
      setUseBridgeDeck(c.useBridgeDeck !== false);
      setBridgeDeck(c.bridgedeck);
    }).catch(() => undefined);
  }, []);
  async function saveVault(shared = useBridgeDeck) {
    try {
      const saved = await window.mimir.memory.setObsidian(vault.trim() || null, shared);
      setVault(saved.vault ?? "");
      setUseBridgeDeck(saved.useBridgeDeck !== false);
      setVaultNote(saved.warning ? { ok: false, text: saved.warning }
        : { ok: true, text: shared && bridgedeck?.enabled ? "Mimir uses BridgeDeck's notes vault, from your next message." : saved.vault ? "Mimir keeps its memory in Mimir/ in that vault, from your next message." : "Not using Obsidian." });
    } catch (e) {
      setVaultNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

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
          <div className="memory-panel__field">
            <strong>Obsidian</strong>
            {bridgedeck && (
              <label className="hint">
                <input type="checkbox" checked={useBridgeDeck} onChange={(e) => { setUseBridgeDeck(e.target.checked); void saveVault(e.target.checked); }} />{" "}
                Use BridgeDeck's notes vault (recommended).{" "}
                {bridgedeck.enabled
                  ? `This memory is the notes "Mimir's memory" and "About you (Mimir)" there (${bridgedeck.path}); Mimir searches and reads your notes, and saves new ones in Mimir/Notes through BridgeDeck.`
                  : "BridgeDeck's vault is off: turn it on in BridgeDeck's Notes settings. Until then Mimir uses the folder below, if any."}
              </label>
            )}
            {(!bridgedeck || !useBridgeDeck || !bridgedeck.enabled) && <>
            <span className="hint">Keep this memory in your Obsidian vault too: Mimir/Memory.md and Mimir/About me.md (edit them in Obsidian and Mimir reads your edit), Mimir's daily logs in Mimir/Daily, and Mimir can search and read your notes and save longer ones in Mimir/Notes. Nothing else in the vault is changed.</span>
            <div className="key-row">
              <input placeholder="Your vault's folder, e.g. /Users/you/Documents/Obsidian Vault" value={vault} onChange={(e) => setVault(e.target.value)} />
              <button type="button" className="btn" onClick={() => void saveVault()}>{vault.trim() ? "Use this vault" : "Turn off"}</button>
            </div>
            </>}
            {vaultNote && <p className={`hint${vaultNote.ok ? "" : " setup-step__result--error"}`}>{vaultNote.text}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
