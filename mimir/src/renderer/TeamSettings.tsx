import React, { useEffect, useState } from "react";
import type { AgentEngine, BrainProviderKind, BrainRole, RoleConfig, RoleEndpoint, RoleStatus, TeamConfig, TeamPreset, ToolTierChoice } from "../shared/types.js";

const ROLE_TEXT: Record<BrainRole, { title: string; job: string }> = {
  head: { title: "Head", job: "Plans the work and writes the answer." },
  executor: { title: "Executor", job: "Makes the tool calls, one step at a time." },
  checker: { title: "Checker", job: "Reviews each result and sends it back if it misses." }
};
const ENGINES: Array<{ id: AgentEngine; label: string; hint: string }> = [
  { id: "mimir", label: "Mimir", hint: "Mimir's own tools and skills, with one model or the team below." },
  { id: "claude-code", label: "Claude Code", hint: "Claude Code runs headless in the coding folder, with its own tools (Read, Edit, Bash, …)." },
  { id: "opencode", label: "OpenCode", hint: "OpenCode runs headless in the coding folder, with its own tools." },
  { id: "hermes", label: "Hermes", hint: "Hermes Agent (Nous Research) runs the chat with its own loop, skills and memory, and starts each conversation knowing what Mimir knows about you. Install it from hermes-agent.nousresearch.com with its ACP extra." }
];
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
  const external = config.engine !== "mimir";
  // An outside agent on the team's models uses the Head (its main model) and the Executor (its
  // small, fast model); Mimir's own team adds the Checker.
  const showRoles = config.mode === "team" || (external && config.engineModels === "team");
  const shownRoles: BrainRole[] = external ? ["head", "executor"] : config.checkerSameAsHead ? ["head", "executor"] : ["head", "executor", "checker"];

  return (
    <section>
      <h3>Brain team</h3>
      <EngineSection config={config} onPatch={(next) => void patch(next)} />

      {!external && <div className="team-mode" role="radiogroup" aria-label="Brain mode">
        <label className="checkbox-row">
          <input type="radio" checked={config.mode === "single"} onChange={() => void patch({ mode: "single" })} />
          One model does everything (the Brain above)
        </label>
        <label className="checkbox-row">
          <input type="radio" checked={config.mode === "team"} onChange={() => void patch({ mode: "team" })} />
          A team: a Head plans and checks, an Executor does the tool work
        </label>
      </div>}

      {showRoles && (
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
            <RoleEditor key={which} which={which} role={config.roles[which]} showTier={!external} onChange={(r) => setRole(which, r)} />
          ))}

          {!external && (
            <>
              <label className="checkbox-row">
                <input type="checkbox" checked={config.checkerSameAsHead} onChange={(e) => void patch({ checkerSameAsHead: e.target.checked })} />
                The Head also checks the work (no extra model to load)
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={config.checkEachStep} onChange={(e) => void patch({ checkEachStep: e.target.checked })} />
                Check each step as it finishes (off: check all steps together, which swaps models less on a small machine)
              </label>
            </>
          )}

          <div className="key-row">
            <button type="button" className="btn" disabled={checking} onClick={() => void check()}>
              {checking ? "Checking…" : "Check the servers"}
            </button>
          </div>
          {statuses && (
            <ul className="team-status">
              {statuses.filter((s) => shownRoles.includes(s.role)).map((s) => (
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
      <div className="team-role">
        <div className="team-role__head">
          <strong>Pictures</strong>
          <span className="hint">A model that can see reads photos (homework, whiteboards, handwriting) for a chat model that can't.</span>
        </div>
        {config.vision ? (
          <>
            <EndpointEditor key={endpointKey(config.vision)} label="Vision model" endpoint={config.vision} onChange={(vision) => void patch({ vision })} />
            <button type="button" className="btn btn--ghost" onClick={() => void patch({ vision: null })}>
              Don't use one (send pictures as they are)
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--ghost" onClick={() => void patch({ vision: { provider: "openai-compatible", model: "qwen3.5-9b", baseUrl: "http://127.0.0.1:8080" } })}>
            Use a vision model
          </button>
        )}
      </div>
      {message && <p className="hint">{message}</p>}
    </section>
  );
}

function EngineSection({ config, onPatch }: { config: TeamConfig; onPatch: (next: Partial<TeamConfig>) => void }) {
  const [check, setCheck] = useState<{ ok: boolean; detail: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const engine = config.engine;
  const savedCommand = engine === "mimir" ? null : config.engineCommands[engine];
  const [command, setCommand] = useState(savedCommand ?? "");
  const [shownFor, setShownFor] = useState(engine);
  if (shownFor !== engine) {
    // Switched engines: show that engine's saved command and forget the old check.
    setShownFor(engine);
    setCommand(savedCommand ?? "");
    setCheck(null);
  }

  async function runCheck(which: "claude-code" | "opencode" | "hermes") {
    setChecking(true);
    try {
      setCheck(await window.mimir.team.checkEngine(which));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="team-engine">
      <div className="team-engine__pick" role="radiogroup" aria-label="Who runs the chat">
        {ENGINES.map((e) => (
          <button key={e.id} type="button" role="radio" aria-checked={engine === e.id} className={`team-engine__option${engine === e.id ? " team-engine__option--on" : ""}`} onClick={() => onPatch({ engine: e.id })}>
            {e.label}
          </button>
        ))}
      </div>
      <p className="hint">{ENGINES.find((e) => e.id === engine)?.hint}</p>
      {engine !== "mimir" && (
        <>
          <label className="checkbox-row">
            <input type="radio" checked={config.engineModels === "team"} onChange={() => onPatch({ engineModels: "team" })} />
            Use the team's models below (the PC's when it's on)
          </label>
          <label className="checkbox-row">
            <input type="radio" checked={config.engineModels === "own"} onChange={() => onPatch({ engineModels: "own" })} />
            {engine === "claude-code" ? "Use Claude's own models (your Claude login)" : engine === "hermes" ? "Use Hermes's own setup (your ~/.hermes profile)" : "Use OpenCode's own models and logins"}
          </label>
          <div className="key-row">
            <input
              placeholder={engine === "claude-code" ? "claude" : engine}
              title="The command, if it isn't on PATH"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onBlur={() => command.trim() !== (savedCommand ?? "") && onPatch({ engineCommands: { ...config.engineCommands, [engine]: command.trim() || null } })}
            />
            <button type="button" className="btn" disabled={checking} onClick={() => void runCheck(engine)}>
              {checking ? "Checking…" : "Is it installed?"}
            </button>
          </div>
          {check && <p className={`hint ${check.ok ? "ok" : "down"}`}>{check.detail}</p>}
          <p className="hint">It works in the coding folder (Settings → Coding). Every command, and every file change outside Projects, waits for your Allow in the chat.</p>
          {engine === "hermes" && <HonchoSection config={config} onPatch={onPatch} />}
        </>
      )}
    </div>
  );
}

/** Honcho (honcho.dev) as Hermes's long-term memory: it builds a model of you from your chats.
 * Off by default: honcho.dev bills about $2 per million tokens it reads, or it can be self-hosted. */
function HonchoSection({ config, onPatch }: { config: TeamConfig; onPatch: (next: Partial<TeamConfig>) => void }) {
  const h = config.honcho;
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(h.baseUrl ?? "");
  const [peer, setPeer] = useState(h.peerName);
  return (
    <div className="team-role">
      <div className="team-role__head">
        <strong>Honcho memory</strong>
        <span className="hint">Hermes remembers you across chats with Honcho: it learns how you work and what you care about, not only facts.</span>
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={h.enabled} onChange={(e) => onPatch({ honcho: { ...h, enabled: e.target.checked } })} />
        Use Honcho (needs the plugin once: hermes plugins install honcho)
      </label>
      {h.enabled && (
        <>
          <div className="key-row">
            <input type="password" placeholder={h.keySaved ? "API key saved (type to replace)" : "honcho.dev API key"} value={key} onChange={(e) => setKey(e.target.value)} />
            <button type="button" className="btn" disabled={!key.trim()} onClick={() => void window.mimir.team.setHonchoKey(key).then(() => { setKey(""); onPatch({ honcho: { ...h, keySaved: true } }); })}>Save key</button>
          </div>
          <div className="key-row">
            <input placeholder="Or a self-hosted server, e.g. http://localhost:8000" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url.trim() !== (h.baseUrl ?? "") && onPatch({ honcho: { ...h, baseUrl: url.trim() || null } })} />
          </div>
          <div className="key-row">
            <input placeholder="Your name to Honcho" value={peer} onChange={(e) => setPeer(e.target.value)} onBlur={() => peer.trim() && peer.trim() !== h.peerName && onPatch({ honcho: { ...h, peerName: peer.trim() } })} />
          </div>
          <p className="hint">honcho.dev charges about $2 per million tokens of chat it reads (new accounts get some free credit); a self-hosted Honcho is free but needs its own server and model. Honcho only runs while Hermes is the engine and uses the team's models.</p>
        </>
      )}
    </div>
  );
}

function RoleEditor({ which, role, showTier, onChange }: { which: BrainRole; role: RoleConfig; showTier: boolean; onChange: (role: RoleConfig) => void }) {
  return (
    <div className="team-role">
      <div className="team-role__head">
        <strong>{ROLE_TEXT[which].title}</strong>
        <span className="hint">{ROLE_TEXT[which].job}</span>
        {showTier && (
          <select title="How many tools this model gets" value={role.tier} onChange={(e) => onChange({ ...role, tier: e.target.value as ToolTierChoice })}>
            <option value="auto">Tools: by model size</option>
            <option value="core">Tools: small set</option>
            <option value="full">Tools: all</option>
          </select>
        )}
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
