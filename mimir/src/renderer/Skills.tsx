import React, { useEffect, useMemo, useState } from "react";
import type { BuiltInCapability, LoadedPromptModule, PromptModuleInfo, SkillSummary } from "../shared/types.js";
import { LLAMA31_CAPABILITIES } from "../shared/llama31Capabilities.js";

type Tab = "mine" | "tools" | "loading";

const STATUS_TEXT: Record<SkillSummary["status"], string> = {
  passed: "Verified",
  failed: "Failed",
  unverified: "Not run yet"
};

/** Failed first (they need attention), then never-run, then verified; A-Z within each. */
const STATUS_ORDER: Record<SkillSummary["status"], number> = { failed: 0, unverified: 1, passed: 2 };

function matchesQuery(query: string, ...fields: string[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || fields.some((f) => f.toLowerCase().includes(q));
}

function formatVerifiedAt(verifiedAt: number | null): string {
  if (verifiedAt === null) return "Never run";
  const minutes = Math.max(0, Math.round((Date.now() - verifiedAt) / 60_000));
  if (minutes < 1) return "Verified just now";
  if (minutes < 60) return `Verified ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Verified ${hours}h ago`;
  return `Verified ${Math.round(hours / 24)}d ago`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * What Mimir can do, in three plain lists: the skills it taught itself, the
 * built-in tools, and which prompt modules it loads (and when) — the last
 * one is what keeps a small local model's context small.
 */
export default function Skills({ onClose, lastLoaded }: { onClose: () => void; lastLoaded: LoadedPromptModule[] }) {
  const [tab, setTab] = useState<Tab>("mine");
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [builtIns, setBuiltIns] = useState<BuiltInCapability[] | null>(null);
  const [modules, setModules] = useState<PromptModuleInfo[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<Set<string>>(new Set());
  const [skillsRoot, setSkillsRoot] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    void window.mimir.skills.getRoot().then(setSkillsRoot);
    void window.mimir.skills.listBuiltIns().then(setBuiltIns);
    void window.mimir.skills.listModules().then(setModules);
  }, []);

  async function refresh() {
    setSkills(await window.mimir.skills.list());
  }

  async function verify(name: string) {
    setVerifying((prev) => new Set(prev).add(name));
    const updated = await window.mimir.skills.verify(name).catch(() => null);
    setVerifying((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    if (updated) setSkills((prev) => (prev ? prev.map((s) => (s.name === name ? updated : s)) : prev));
  }

  async function verifyAll() {
    for (const skill of skills ?? []) await verify(skill.name);
  }

  const shownSkills = useMemo(
    () =>
      (skills ?? [])
        .filter((s) => matchesQuery(query, s.name, s.description, s.category))
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name)),
    [skills, query]
  );
  const counts = useMemo(() => {
    const all = skills ?? [];
    return { total: all.length, passed: all.filter((s) => s.status === "passed").length, failed: all.filter((s) => s.status === "failed").length };
  }, [skills]);
  const loadedIds = useMemo(() => new Set(lastLoaded.map((m) => m.id)), [lastLoaded]);

  const tabs: Array<{ id: Tab; label: string; count: number | null }> = [
    { id: "mine", label: "My skills", count: skills?.length ?? null },
    { id: "tools", label: "Built-in tools", count: builtIns?.length ?? null },
    { id: "loading", label: "What gets loaded", count: modules?.length ?? null }
  ];

  return (
    <div className="skills">
      <div className="skills-header">
        <h2>Skills</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="skills-toolbar">
        <div className="skills-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "skills-tab skills-tab--active" : "skills-tab"} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count !== null && <span className="skills-tab__count">{t.count}</span>}
            </button>
          ))}
        </div>
        {tab !== "loading" && <input className="skills-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label="Search" />}
      </div>

      {tab === "mine" && (
        <section className="skills-body">
          <div className="skills-summary">
            <span>
              {counts.total} {counts.total === 1 ? "skill" : "skills"}
              {counts.total > 0 && ` · ${counts.passed} verified`}
              {counts.failed > 0 && <strong className="skills-summary__failed"> · {counts.failed} failed</strong>}
            </span>
            <span className="skills-summary__actions">
              {counts.total > 0 && (
                <button type="button" className="btn" disabled={verifying.size > 0} onClick={() => void verifyAll()}>
                  Verify all
                </button>
              )}
              <button type="button" className="btn" onClick={() => void window.mimir.skills.openFolder()}>
                Open folder
              </button>
            </span>
          </div>

          {skills === null && <p className="hint">Loading…</p>}
          {skills !== null && skills.length === 0 && (
            <div className="skills-empty">
              <strong>No skills yet</strong>
              <p>A skill is a small Python routine Mimir saves so it can run it again. Try asking:</p>
              <code>Teach yourself a skill that converts resistor color bands to ohms.</code>
            </div>
          )}
          {skills !== null && skills.length > 0 && shownSkills.length === 0 && <p className="hint">No skill matches “{query}”.</p>}

          <ul className="skill-list">
            {shownSkills.map((skill) => {
              const isOpen = open === skill.name;
              const busy = verifying.has(skill.name);
              return (
                <li key={skill.name} className={`skill-card skill-card--${skill.status}`}>
                  <button type="button" className="skill-card__head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : skill.name)}>
                    <span className={`skill-dot skill-dot--${skill.status}`} title={STATUS_TEXT[skill.status]} />
                    <span className="skill-card__main">
                      <span className="skill-card__name">{skill.name}</span>
                      <span className="skill-card__desc">{skill.description}</span>
                    </span>
                    <span className="skill-card__tags">
                      <span className="skill-tag">{skill.category}</span>
                      {skill.hasParameters && <span className="skill-tag skill-tag--tool" title={`Mimir can call this directly as skill_${skill.name}`}>tool</span>}
                    </span>
                    <span className="skill-card__chevron" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && (
                    <div className="skill-card__body">
                      <p className="skills-meta">
                        {skill.status === "passed" || skill.status === "failed" ? `${STATUS_TEXT[skill.status]} · ${formatVerifiedAt(skill.verifiedAt)}` : "Not run yet"}
                        {skill.parent && ` · builds on ${skill.parent}`}
                        {skill.hasParameters && " · takes arguments, so it is checked by a real call"}
                      </p>
                      {skill.status === "failed" && skill.error && <pre className="skill-error">{skill.error}</pre>}
                      <pre className="skill-code">{skill.code}</pre>
                      <button type="button" className="btn" disabled={busy} onClick={() => void verify(skill.name)}>
                        {busy ? "Verifying…" : "Verify now"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {skillsRoot && <p className="hint skills-path">{skillsRoot}</p>}
        </section>
      )}

      {tab === "tools" && (
        <section className="skills-body">
          {builtIns === null && <p className="hint">Loading…</p>}
          {builtIns !== null && <ToolGroups tools={builtIns} modules={modules ?? []} query={query} />}
          <details className="skills-reference">
            <summary>Llama 3.1 8B reference ({LLAMA31_CAPABILITIES.length}) — not installed, for comparison only</summary>
            <ul className="skills-plain">
              {LLAMA31_CAPABILITIES.filter((c) => matchesQuery(query, c.name, c.description)).map((c) => (
                <li key={c.name}>
                  <strong>{c.name}</strong> <span className="skill-tag">{c.grade}</span>
                  <span className="skills-meta"> {c.description}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {tab === "loading" && (
        <section className="skills-body">
          <p className="hint">
            Mimir does not send everything on every message. It always sends the required module; the others are added one at a time, only when your message needs them and they fit the budget.
            Sizes are estimated tokens (prompt text plus tool descriptions) for a small local model.
          </p>
          {modules === null && <p className="hint">Loading…</p>}
          <ul className="skill-list">
            {(modules ?? []).map((m) => (
              <li key={m.id} className={loadedIds.has(m.id) ? "module-card module-card--loaded" : "module-card"}>
                <div className="module-card__head">
                  <strong>{m.title}</strong>
                  {m.required && <span className="skill-tag skill-tag--required">always</span>}
                  {!m.tiers.includes("core") && <span className="skill-tag" title="Only offered to larger models">larger models</span>}
                  {loadedIds.has(m.id) && <span className="skill-tag skill-tag--loaded">loaded last message</span>}
                  <span className="module-card__size">{m.tiers.includes("core") ? `~${formatTokens(m.coreTokens)}` : `~${formatTokens(m.fullTokens)}`}</span>
                </div>
                <p className="skills-meta">{m.summary}</p>
                <p className="skills-meta">
                  <em>Loads:</em> {m.when}
                </p>
                {(m.tools.length > 0) && (
                  <p className="skills-meta module-card__tools">
                    {m.tools.map((t) => (
                      <code key={t} className={m.coreTools.includes(t) ? "tool-chip" : "tool-chip tool-chip--large"} title={m.coreTools.includes(t) ? "Small and large models" : "Larger models only"}>
                        {t}
                      </code>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ToolGroups({ tools, modules, query }: { tools: BuiltInCapability[]; modules: PromptModuleInfo[]; query: string }) {
  const groups = useMemo(() => {
    const byModule = new Map<string, BuiltInCapability[]>();
    for (const tool of tools) {
      if (!matchesQuery(query, tool.name, tool.description, tool.category)) continue;
      byModule.set(tool.category, [...(byModule.get(tool.category) ?? []), tool]);
    }
    return [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools, query]);
  const whenByTitle = new Map(modules.map((m) => [m.title, m.when]));
  if (groups.length === 0) return <p className="hint">No tool matches “{query}”.</p>;
  return (
    <>
      {groups.map(([category, list]) => (
        <details key={category} className="tool-group" open={query.trim().length > 0}>
          <summary>
            <strong>{category}</strong>
            <span className="skills-tab__count">{list.length}</span>
            {whenByTitle.get(category) && <span className="skills-meta"> · loads when: {whenByTitle.get(category)}</span>}
          </summary>
          <ul className="skills-plain">
            {list.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                <span className="skills-meta"> {firstSentence(t.description)}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}

function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](\s|$)/s);
  const sentence = (match ? match[0] : text).trim();
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}
