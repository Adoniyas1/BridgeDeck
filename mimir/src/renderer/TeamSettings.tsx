import React, { useEffect, useState } from "react";
import type { BrainProviderKind, BrainRole, RoleConfig, RoleEndpoint, RoleStatus, TeamConfig, TeamPreset, ToolTierChoice } from "../shared/types.js";

const ROLE_TEXT: Record<BrainRole, { title: string; job: string }> = {
  head: { title: "Head", job: "Plans the work and writes the answer." },
  executor: { title: "Executor", job: "Makes the tool calls, one step at a time." },
  checker: { title: "Checker", job: "Reviews each result and sends it back if it misses." }
};
const PROVIDERS: Array<{ id: BrainProviderKind; label: string }> = [
  { id: "openai-compatible", label: "OpenAI-compatible (MLX, llama.cpp, llama-swap)" },
  { id: "ollama", label: "Ollama" },
  { id: "anthropic", label: "Anthropic" }
];

/** The Brain team: one model for everything, or a Head, Executor and Checker, each with a server
 * to try first (the PC) and one to fall back to (this computer). Saved per computer. */
export default function TeamSettings() {
  const [config, setConfig] = useState<TeamConfig | null>(null);
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [statuses, setStatuses] = useState<RoleStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [pcAddress, setPcAddress] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void window.mimir.team.getConfig().then(setConfig);
    void window.mimir.team.presets().then(setPresets);
  }, []);

  if (!config) return null;

  async function patch(next: Partial<TeamConfig>) {
    try {
      setConfig(await window.mimir.team.setConfig(next));
      setStatuses(null);
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function applyPreset(preset: TeamPreset) {
    try {
      setConfig(await window.mimir.team.applyPreset(preset.id, preset.needsPcAddress ? pcAddress : undefined));
      setMessage(`Using “${preset.title}”.`);
      setStatuses(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function check() {
    setChecking(true);
    try {
      setStatuses(await window.mimir.team.status());
    } finally {
      setChecking(false);
    }
  }

  const setRole = (which: BrainRole, role: RoleConfig) => void patch({ roles: { ...config.roles, [which]: role } });
  const shownRoles: BrainRole[] = config.checkerSameAsHead ? ["head", "executor"] : ["head", "executor", "checker"];

  return (
    <section>
      <h3>Brain team</h3>
      <div className="team-mode" role="radiogroup" aria-label="Brain mode">
        <label className="checkbox-row">
          <input type="radio" checked={config.mode === "single"} onChange={() => void patch({ mode: "single" })} />
          One model does everything (the Brain above)
        </label>
        <label className="checkbox-row">
          <input type="radio" checked={config.mode === "team"} onChange={() => void patch({ mode: "team" })} />
          A team: a Head plans and checks, an Executor does the tool work
        </label>
      </div>

      {config.mode === "team" && (
        <>
          <div className="team-presets">
            {presets.map((p) => (
              <div key={p.id} className={`team-preset${config.preset === p.id ? " team-preset--active" : ""}`}>
                <strong>{p.title}</strong>
                <p className="hint">{p.description}</p>
                {p.needsPcAddress && (
                  <input placeholder="PC address, e.g. 192.168.1.20:8080" value={pcAddress} onChange={(e) => setPcAddress(e.target.value)} />
                )}
                <button type="button" className="btn" disabled={p.needsPcAddress && !pcAddress.trim()} onClick={() => void applyPreset(p)}>
                  {config.preset === p.id ? "Apply again" : "Use this"}
                </button>
              </div>
            ))}
          </div>

          {shownRoles.map((which) => (
            <RoleEditor key={which} which={which} role={config.roles[which]} onChange={(r) => setRole(which, r)} />
          ))}

          <label className="checkbox-row">
            <input type="checkbox" checked={config.checkerSameAsHead} onChange={(e) => void patch({ checkerSameAsHead: e.target.checked })} />
            The Head also checks the work (no extra model to load)
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={config.checkEachStep} onChange={(e) => void patch({ checkEachStep: e.target.checked })} />
            Check each step as it finishes (off: check all steps together, which swaps models less on a small machine)
          </label>

          <div className="key-row">
            <button type="button" className="btn" disabled={checking} onClick={() => void check()}>
              {checking ? "Checking…" : "Check the servers"}
            </button>
          </div>
          {statuses && (
            <ul className="team-status">
              {statuses.map((s) => (
                <li key={s.role} className={s.reachable ? "ok" : "down"}>
                  <strong>{ROLE_TEXT[s.role].title}</strong>
                  {s.endpoint && <code>{s.endpoint.model}</code>}
                  {s.using === "fallback" && <span className="team-tag">fallback</span>}
                  <span className="hint">{s.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {message && <p className="hint">{message}</p>}
    </section>
  );
}

function RoleEditor({ which, role, onChange }: { which: BrainRole; role: RoleConfig; onChange: (role: RoleConfig) => void }) {
  return (
    <div className="team-role">
      <div className="team-role__head">
        <strong>{ROLE_TEXT[which].title}</strong>
        <span className="hint">{ROLE_TEXT[which].job}</span>
        <select title="How many tools this model gets" value={role.tier} onChange={(e) => onChange({ ...role, tier: e.target.value as ToolTierChoice })}>
          <option value="auto">Tools: by model size</option>
          <option value="core">Tools: small set</option>
          <option value="full">Tools: all</option>
        </select>
      </div>
      <EndpointEditor key={endpointKey(role.primary)} label="Try first" endpoint={role.primary} onChange={(primary) => onChange({ ...role, primary })} />
      {role.fallback ? (
        <>
          <EndpointEditor key={endpointKey(role.fallback)} label="If that's off" endpoint={role.fallback} onChange={(fallback) => onChange({ ...role, fallback })} />
          <button type="button" className="btn btn--ghost" onClick={() => onChange({ ...role, fallback: null })}>
            Remove the fallback
          </button>
        </>
      ) : (
        <button type="button" className="btn btn--ghost" onClick={() => onChange({ ...role, fallback: { ...role.primary } })}>
          Add a fallback server
        </button>
      )}
    </div>
  );
}

const endpointKey = (e: RoleEndpoint) => `${e.provider}|${e.baseUrl ?? ""}|${e.model}`;

function EndpointEditor({ label, endpoint, onChange }: { label: string; endpoint: RoleEndpoint; onChange: (e: RoleEndpoint) => void }) {
  // Remounted (by key) when the saved endpoint changes, so these start from what's saved.
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(endpoint.model);
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl ?? "");
  const { provider, baseUrl: savedBase } = endpoint;
  useEffect(() => {
    void window.mimir.team.listModels({ provider, baseUrl: savedBase, model: "" }).then(setModels).catch(() => setModels([]));
  }, [provider, savedBase]);
  const listId = `models-${label}-${endpoint.provider}-${endpoint.baseUrl ?? ""}`;
  return (
    <div className="team-endpoint">
      <span className="team-endpoint__label">{label}</span>
      <select value={endpoint.provider} onChange={(e) => onChange({ ...endpoint, provider: e.target.value as BrainProviderKind })}>
        {PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {endpoint.provider !== "anthropic" && (
        <input
          placeholder={endpoint.provider === "ollama" ? "localhost:11434" : "127.0.0.1:8080"}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={() => baseUrl !== (endpoint.baseUrl ?? "") && onChange({ ...endpoint, baseUrl: baseUrl.trim() || null })}
        />
      )}
      <input
        list={listId}
        placeholder="model"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        onBlur={() => model.trim() && model !== endpoint.model && onChange({ ...endpoint, model: model.trim() })}
      />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}
