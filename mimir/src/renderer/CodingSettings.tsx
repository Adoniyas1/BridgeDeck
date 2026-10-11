import React, { useEffect, useState } from "react";

/** Where the coding tools (Read, Edit, Bash…) work. Commands always ask first; file changes ask
 * first outside the Projects folder. */
export default function CodingSettings() {
  const [projectsRoot, setProjectsRoot] = useState("");
  const [root, setRoot] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void window.mimir.coding.getConfig().then((c) => {
      setProjectsRoot(c.projectsRoot);
      setRoot(c.root ?? "");
    });
  }, []);

  async function save(value: string) {
    try {
      const saved = await window.mimir.coding.setConfig({ root: value.trim() || null });
      setRoot(saved.root ?? "");
      setMessage(saved.root ? `Coding tools now work in ${saved.root}.` : "Coding tools work in your Projects folder.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section>
      <h3>Coding</h3>
      <p className="hint">
        Mimir's coding tools (Read, Edit, Grep, Bash…) start in this folder. Every command asks you first, and so does any file change outside
        your Projects folder.
      </p>
      <label>
        Coding folder (full path; empty for Projects)
        <div className="key-row">
          <input placeholder={projectsRoot} value={root} onChange={(e) => setRoot(e.target.value)} />
          <button type="button" className="btn" onClick={() => void save(root)}>
            Save
          </button>
        </div>
      </label>
      {message && <p className="hint">{message}</p>}
    </section>
  );
}
