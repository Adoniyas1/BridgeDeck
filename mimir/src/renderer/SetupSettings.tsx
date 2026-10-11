import React, { useEffect, useState } from "react";
import type { SetupConfig, SetupModel, SetupStep, SetupView } from "../shared/types.js";

const ROLE_TEXT = { head: "Head", executor: "Executor" } as const;

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

  async function run(step: SetupStep) {
    setBusy(step.id);
    try {
      const result = await window.mimir.setup.run(step.id);
      setView(result.view);
      setNotes((n) => ({ ...n, [step.id]: { ok: result.ok, text: result.message } }));
    } finally {
      setBusy(null);
    }
  }

  const setModel = (role: "head" | "executor", model: SetupModel) => void patch({ models: { ...config.models, [role]: model } });

  return (
    <section>
      <h3>Model servers</h3>
      <p className="hint">
        Gets the Brain team's models running here without a terminal: llama-swap in front of {mac ? "MLX (Apple silicon)" : "llama.cpp on the NVIDIA card"}.
        Programs go in ~/.mimir/bin.
      </p>
      <div className="team-engine__pick" role="radiogroup" aria-label="This computer">
        {(["mac", "pc"] as const).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={config.computer === c} className={`team-engine__option${config.computer === c ? " team-engine__option--on" : ""}`} onClick={() => void patch({ computer: c })}>
            {c === "mac" ? "Mac (MLX)" : "Windows PC (llama.cpp)"}
          </button>
        ))}
      </div>

      {(["head", "executor"] as const).map((role) => (
        <ModelRow key={`${config.computer}-${role}-${config.models[role].source}-${config.models[role].args}`} label={ROLE_TEXT[role]} model={config.models[role]} showArgs={!mac} onChange={(m) => setModel(role, m)} />
      ))}

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
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => void run(step)}>
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

function ModelRow({ label, model, showArgs, onChange }: { label: string; model: SetupModel; showArgs: boolean; onChange: (m: SetupModel) => void }) {
  // Remounted (by key) when the saved model changes, so these start from what's saved.
  const [source, setSource] = useState(model.source);
  const [args, setArgs] = useState(model.args);
  const save = () => (source.trim() !== model.source || args.trim() !== model.args) && onChange({ ...model, source: source.trim(), args: args.trim() });
  return (
    <div className="team-endpoint setup-model">
      <span className="team-endpoint__label">
        {label} <code>{model.name}</code>
      </span>
      <input title="Hugging Face repo (GGUF: repo:quant)" value={source} onChange={(e) => setSource(e.target.value)} onBlur={save} />
      {showArgs && <input title="Extra llama-server arguments" placeholder="extra arguments" value={args} onChange={(e) => setArgs(e.target.value)} onBlur={save} />}
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
