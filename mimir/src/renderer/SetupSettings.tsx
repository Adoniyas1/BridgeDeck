import React, { useEffect, useState } from "react";
import type { SetupConfig, SetupModel, SetupView, StorageItem } from "../shared/types.js";

const ROLE_TEXT = { head: "Head", executor: "Executor", checker: "Checker" } as const;
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** Settings → Model servers: the steps to get llama-swap and the team's models running on this
 * computer, each with a check and a button (src/main/setup). */
export default function SetupSettings() {
  const [view, setView] = useState<SetupView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({});

  useEffect(() => {
    void window.mimir.setup.get().then(setView);
  }, []);

  if (!view) return null;
  const { config } = view;
  const mac = config.computer === "mac";

  async function patch(next: Partial<SetupConfig>) {
    setView(await window.mimir.setup.setConfig(next));
  }

  async function run(id: string) {
    setBusy(id);
    try {
      const result = await window.mimir.setup.run(id);
      setView(result.view);
      setNotes((n) => ({ ...n, [id]: { ok: result.ok, text: result.message } }));
    } finally {
      setBusy(null);
    }
  }

  function free(item: StorageItem) {
    if (window.confirm(`Delete ${item.label} (${gb(item.bytes)})?\n\n${item.path}`)) void run(`free:${item.id}`);
  }

  const setModel = (role: "head" | "executor" | "checker", model: SetupModel) => void patch({ models: { ...config.models, [role]: model } });
  const roles = (["head", "executor", "checker"] as const).filter((r) => config.models[r]);

  return (
    <section>
      <h3>Model servers</h3>
      <p className="hint">
        Gets the Brain team's models running here without a terminal: llama-swap in front of llama.cpp{mac ? " on the Mac's GPU" : " on the NVIDIA card"}.
        Programs Mimir downloads go in ~/.mimir/bin. {gb(view.memory.availableBytes)} of {gb(view.memory.totalBytes)} memory free right now.
      </p>
      <div className="team-engine__pick" role="radiogroup" aria-label="This computer">
        {(["mac", "pc"] as const).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={config.computer === c} className={`team-engine__option${config.computer === c ? " team-engine__option--on" : ""}`} onClick={() => void patch({ computer: c })}>
            {c === "mac" ? "Mac" : "Windows PC"}
          </button>
        ))}
      </div>

      {roles.map((role) => (
        <ModelRow key={`${config.computer}-${role}-${config.models[role]!.source}-${config.models[role]!.args}`} label={ROLE_TEXT[role]} model={config.models[role]!} found={view.found.models.map((m) => m.path)} onChange={(m) => setModel(role, m)} />
      ))}
      <ServerRow key={config.serverPath ?? ""} saved={config.serverPath} using={view.server} found={view.found.servers} onChange={(serverPath) => void patch({ serverPath })} />
      <FoldersRow key={config.modelDirs.join("|")} saved={config.modelDirs} count={view.found.models.length} onChange={(modelDirs) => void patch({ modelDirs })} />

      <label className="checkbox-row">
        <input type="checkbox" checked={config.keepBothLoaded} onChange={(e) => void patch({ keepBothLoaded: e.target.checked })} />
        Keep both models loaded (needs memory for both; off: they take turns)
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={config.autostart} onChange={(e) => void patch({ autostart: e.target.checked })} />
        Start llama-swap when Mimir starts
      </label>

      <ol className="setup-steps">
        {view.steps.map((step) => (
          <li key={step.id} className={`setup-step setup-step--${step.state}`}>
            <span className="setup-step__dot" aria-label={step.state === "done" ? "Done" : step.state === "error" ? "Needs attention" : "To do"} />
            <div className="setup-step__body">
              <div className="setup-step__head">
                <strong>{step.title}</strong>
                {step.action && (
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => void run(step.id)}>
                    {busy === step.id ? "Working…" : step.action}
                  </button>
                )}
              </div>
              <p className="hint">{step.detail}</p>
              {step.command && step.state !== "done" && <CommandLine command={step.command} />}
              {step.note && <p className="hint">{step.note}</p>}
              {notes[step.id] && <p className={`hint setup-step__result${notes[step.id]!.ok ? "" : " setup-step__result--error"}`}>{notes[step.id]!.text}</p>}
            </div>
          </li>
        ))}
      </ol>

      {view.storage.length > 0 && (
        <div className="setup-storage">
          <strong>Disk space</strong>
          {view.storage.map((item) => (
            <div key={item.id} className="setup-storage__row">
              <span>
                {item.label} · {gb(item.bytes)}
                <span className="hint"> {item.hint}</span>
              </span>
              {item.deletable && (
                <button type="button" className="btn btn--ghost" disabled={busy !== null} onClick={() => free(item)}>
                  {busy === `free:${item.id}` ? "Deleting…" : "Delete"}
                </button>
              )}
              {notes[`free:${item.id}`] && <span className="hint">{notes[`free:${item.id}`]!.text}</span>}
            </div>
          ))}
        </div>
      )}

      <details className="setup-details">
        <summary>llama-swap config ({view.configPath})</summary>
        <pre>{view.yaml}</pre>
      </details>
      {view.swapLog && (
        <details className="setup-details">
          <summary>llama-swap output</summary>
          <pre>{view.swapLog}</pre>
        </details>
      )}
    </section>
  );
}

function ModelRow({ label, model, found, onChange }: { label: string; model: SetupModel; found: string[]; onChange: (m: SetupModel) => void }) {
  // Remounted (by key) when the saved model changes, so these start from what's saved.
  const [source, setSource] = useState(model.source);
  const [args, setArgs] = useState(model.args);
  const save = () => (source.trim() !== model.source || args.trim() !== model.args) && onChange({ ...model, source: source.trim(), args: args.trim() });
  return (
    <div className="team-endpoint setup-model">
      <span className="team-endpoint__label">
        {label} <code>{model.name}</code>
      </span>
      <input list={`found-${label}`} title="A .gguf file on this computer, or a Hugging Face repo:quant" value={source} onChange={(e) => setSource(e.target.value)} onBlur={save} />
      <datalist id={`found-${label}`}>
        {found.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <input title="llama-server arguments" placeholder="extra arguments" value={args} onChange={(e) => setArgs(e.target.value)} onBlur={save} />
    </div>
  );
}

function FoldersRow({ saved, count, onChange }: { saved: string[]; count: number; onChange: (dirs: string[]) => void }) {
  const [value, setValue] = useState(saved.join("; "));
  const parse = (text: string) => text.split(";").map((d) => d.trim()).filter(Boolean);
  return (
    <div className="team-endpoint setup-model">
      <span className="team-endpoint__label">
        Model folders <code>{count} .gguf found</code>
      </span>
      <input
        placeholder="Extra folders to search, e.g. D:\AI\models; C:\Users\you\LLMs"
        title="Separate folders with ;. Bonsai-demo, Downloads, Documents, the Hugging Face, llama.cpp and LM Studio caches are searched already."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => parse(value).join("|") !== saved.join("|") && onChange(parse(value))}
      />
    </div>
  );
}

function ServerRow({ saved, using, found, onChange }: { saved: string | null; using: string | null; found: string[]; onChange: (p: string | null) => void }) {
  const [value, setValue] = useState(saved ?? "");
  return (
    <div className="team-endpoint setup-model">
      <span className="team-endpoint__label">llama-server</span>
      <input
        list="found-servers"
        placeholder={using ?? "found automatically"}
        title="Leave empty to use Bonsai-demo's build, Mimir's, or one on PATH"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value.trim() !== (saved ?? "") && onChange(value.trim() || null)}
      />
      <datalist id="found-servers">
        {found.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>
  );
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setup-command">
      <code>{command}</code>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
