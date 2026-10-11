import React, { useEffect, useState } from "react";
import type { McpPreset, McpServerConfig, McpServerStatus } from "../shared/types.js";

const STATE_TEXT: Record<McpServerStatus["state"], string> = { off: "Off", starting: "Starting…", ready: "Ready", failed: "Couldn't start" };

/** MCP servers: tool servers anyone can write (github.com/modelcontextprotocol/servers), started by
 * Mimir and used like its own tools. Tools that change things ask first unless a server is trusted. */
export default function McpSettings() {
  const [servers, setServers] = useState<McpServerConfig[] | null>(null);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [status, setStatus] = useState<McpServerStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [custom, setCustom] = useState({ id: "", name: "", command: "", args: "" });
  const [message, setMessage] = useState("");

  useEffect(() => {
    void window.mimir.mcp.getConfig().then((c) => setServers(c.servers));
    void window.mimir.mcp.presets().then(setPresets);
  }, []);

  if (!servers) return null;
  const list = servers;

  async function save(next: McpServerConfig[]) {
    try {
      const saved = await window.mimir.mcp.setConfig({ servers: next });
      setServers(saved.servers);
      setStatus([]);
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function check(retryId?: string) {
    setChecking(true);
    try {
      setStatus(await window.mimir.mcp.status(retryId));
    } finally {
      setChecking(false);
    }
  }

  const update = (id: string, patch: Partial<McpServerConfig>) => void save(list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const unused = presets.filter((p) => !servers.some((s) => s.id === p.server.id));

  function addCustom() {
    const id = custom.id.trim() || custom.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 24);
    if (!id || !custom.command.trim()) return;
    void save([...list, { id, name: custom.name.trim() || id, command: custom.command.trim(), args: custom.args.trim() ? custom.args.trim().split(/\s+/) : [], env: {}, enabled: true, keywords: [], trusted: false }]);
    setCustom({ id: "", name: "", command: "", args: "" });
  }

  return (
    <section>
      <h3>Tool servers (MCP)</h3>
      <p className="hint">
        Any Model Context Protocol server becomes tools for Mimir and the Brain team. A server's tools load when a message mentions it. Tools that change
        something ask you first, unless you mark the server trusted.
      </p>

      {servers.map((s) => {
        const st = status.find((x) => x.id === s.id);
        return (
          <div key={s.id} className="mcp-server">
            <div className="mcp-server__head">
              <label className="checkbox-row">
                <input type="checkbox" checked={s.enabled} onChange={(e) => update(s.id, { enabled: e.target.checked })} />
                <strong>{s.name}</strong>
              </label>
              <code className="mcp-server__cmd">{[s.command, ...s.args].join(" ")}</code>
              {st && <span className={`mcp-state mcp-state--${st.state}`}>{STATE_TEXT[st.state]}{st.state === "ready" ? ` · ${st.tools.length} tools` : ""}</span>}
              <button type="button" className="btn btn--ghost" onClick={() => void save(servers.filter((x) => x.id !== s.id))}>
                Remove
              </button>
            </div>
            <label className="checkbox-row">
              <input type="checkbox" checked={s.trusted} onChange={(e) => update(s.id, { trusted: e.target.checked })} />
              Trusted: run its tools without asking
            </label>
            <label>
              Words that load its tools
              <input defaultValue={s.keywords.join(", ")} onBlur={(e) => update(s.id, { keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) })} />
            </label>
            {st?.error && (
              <div className="mcp-error">
                <pre>{st.error}</pre>
                <button type="button" className="btn btn--ghost" onClick={() => void check(s.id)}>
                  Try again
                </button>
              </div>
            )}
            {st?.state === "ready" && st.tools.length > 0 && (
              <p className="hint">
                {st.tools.map((t) => `${t.name}${t.readOnly ? "" : " (asks)"}`).join(" · ")}
              </p>
            )}
          </div>
        );
      })}

      {unused.length > 0 && (
        <div className="team-presets">
          {unused.map((p) => (
            <div key={p.id} className="team-preset">
              <strong>{p.name}</strong>
              <p className="hint">{p.description}</p>
              <p className="hint">Needs: {p.needs}</p>
              <button type="button" className="btn" onClick={() => void save([...servers, p.server])}>
                Add
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mcp-custom">
        <input placeholder="Name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
        <input placeholder="Command, e.g. npx" value={custom.command} onChange={(e) => setCustom({ ...custom, command: e.target.value })} />
        <input placeholder="Arguments" value={custom.args} onChange={(e) => setCustom({ ...custom, args: e.target.value })} />
        <button type="button" className="btn" disabled={!custom.command.trim() || !(custom.name.trim() || custom.id.trim())} onClick={addCustom}>
          Add server
        </button>
      </div>

      <div className="key-row">
        <button type="button" className="btn" disabled={checking || !servers.length} onClick={() => void check()}>
          {checking ? "Starting servers…" : "Start and check servers"}
        </button>
      </div>
      {message && <p className="hint">{message}</p>}
    </section>
  );
}
