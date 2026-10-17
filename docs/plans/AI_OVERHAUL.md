# AI overhaul plan

Four pieces, built in this order (each one is a PR, tested on its own):

| # | Piece | Why this order |
|---|---|---|
| 1 | Overload detection | Safety first, small, everything else runs on top of it |
| 2 | Context & KV calculator | Gives the real context size the journal and checkpoints work against |
| 3 | AI Journal (two variants) + search + checkpoints + need-to-know briefs | The big one |
| 4 | Journal analytics | Needs the journal running for a while to have data |
| 5 | AI page redesign | Shows all of the above in one place |

Decisions taken (from the conversation):

- Journal: **two separate variants run side by side** so we can compare them (see 3).
- Context summary ("checkpoint"): **automatic at 90 %**, or whenever you press the button.
- Journal is **synced** (in `BridgeDeck Shared/`).
- Kept **as long as needed**, with **analytics** to see what's used and what isn't (see 4).

Defaults assumed for the redesign questions not yet answered (easy to change):
the orb is small in the status panel (large only on an empty chat); the right panel is open on wide
windows and folds on narrow ones; Open Mic gets a cancel delay plus an optional wake word; the Mimir
page is done first, other tabs later.

---

## 1. Overload detection (real signals, not percentages)

Today the safety stop and the load watch use percentages (94 % RAM, 98 % VRAM, 95 % VRAM, 90 % RAM).
"In use" counts file cache that Windows hands back at once, and 100 % GPU use is just working hard.
Replace them with what actually precedes a crash or a freeze:

| Signal | Windows source | Mac source | Means |
|---|---|---|---|
| Commit charge near the commit limit | `GlobalMemoryStatusEx` (total/avail page file) | `memory_pressure` level | Programs will fail to get memory → crash |
| Hard page faults / sec high and sustained | PDH `\Memory\Pages Input/sec` | `vm_stat` pageins/swapouts delta | Thrashing → the freeze |
| VRAM spilling to shared GPU memory | PDH `\GPU Process Memory(*)\Shared Usage` for llama-server | n/a (unified memory) | Not a crash; 5–10× slower |
| Tokens/s under half its usual | `speed.log` (already written) | same | Something is starving the model |
| Event loop / timer late | already measured (stall check) | same | The computer stopped responding |

Response ladder (each needs the signal for a few readings in a row):

- **Busy** (high use, nothing wrong): nothing, shown as "Busy".
- **Spilling / slow**: lower the GPU share one step (load watch), restart between answers.
- **Commit > 90 % or thrashing**: ease off, then stop the models if it persists.
- **Froze while memory was short**: stop the models at once (as now).

Status shown everywhere as **OK / Busy / Overloaded — reason** (top-bar meter, Activity & safety,
AI page). Old percentage settings become "advanced" overrides.

Tests: parsers for each source, the ladder as a pure function fed recorded readings.

## 2. Context & KV calculator

Read the model's GGUF header (Mimir already reads the layer count): layers, KV heads, key/value
length, sliding-window and which layers use full attention (hybrid models cache far less). From that:

- **KV cache per token** at f16 / q8_0 / q4_0, weights size from the file, plus a compute-buffer
  estimate.
- **What fits**: for each model, the largest context at each KV type that fits the VRAM budget
  (12 GB minus ~1 GB for Windows) at its GPU share.
- **Calibrate**: llama-server prints its real KV and compute buffer sizes when it loads; read them from
  its output and correct the estimate (shown as "measured").

Settings → Model servers (and the AI page): a per-model table, a **Quality / Balanced / Long**
preset (q8 16K / q8 or q4 at the largest that fits / q4 at the largest that fits), then auto-tune
GPU share runs with that context. Mimir reports each turn's prompt size so the AI page can show a real
**context bar**.

## 3. AI Journal

Plain Markdown (frontmatter, `[[links]]`, `#tags`) in `BridgeDeck Shared/AI Journal/`, shown in Notes
and its graph, openable in Obsidian, synced. Our own code.

### Two variants, side by side

| | **A — Full log** | **B — Task log** |
|---|---|---|
| Records | every chat | only turns where the AI used tools (files, code, commands, skills) |
| Folder | `AI Journal/Full/` | `AI Journal/Tasks/` |
| Session note | every exchange, prompt verbatim | prompt verbatim, plan, steps, results, changes |
| Retrieval | the AI searches it | the AI searches it |

Both are written in parallel. **Which one the AI searches is switched per chat (alternating)**, so each
gets real use; analytics (4) compares them. After a few weeks, keep the winner (or both).

### What's written

```
AI Journal/<Full|Tasks>/
  Projects/<name>.md        living brief: what it is, layout, conventions, state, open issues
  Sessions/<date> <title>.md  prompt (verbatim), plan, steps (model, result, checker verdict),
                              commands + output, links to changes, open items, tags
  Changes/<date time> <file>.md  full diff, why, step & model, approval (who/when), commit, Undo
  Checkpoints/<date time>.md  goal, done, decisions, open, files touched (links)
  Decisions/<title>.md      chose X over Y because…
  Daily/<date>.md           links to that day's sessions
```

Captured where it can't be missed: the coding tools (Write/Edit/Bash), skill runs, MCP tool calls and
Mimir's self-edit transactions all record as they happen. Secrets (keys, tokens, passwords in
commands) are redacted before writing; long output is cut with the full text as an attachment.

### Search and lookup (need-to-know)

- Index: SQLite FTS5 in BridgeDeck (SQLite is already bundled), rebuilt from the files (the files are
  the truth, the index is disposable). Mimir reaches it through BridgeDeck's local API.
- AI tools (read-only, no approval): `journal_search`, `journal_read`, `changes_for(file)`,
  `project_brief(project)`.
- **Step briefs**: for each team step the Head writes a brief (goal, relevant files, links, what
  "done" means). The Executor gets only the brief + the tools above; the Checker gets the brief + the
  step's change notes.

### Checkpoints ("summarize & continue")

At **90 % of the context**, or when you press **Summarize now**: write a checkpoint note, then rebuild
the model's context as system prompt + project brief + latest checkpoint + last few exchanges. The full
transcript stays in the journal. After each session the project brief is updated.

## 4. Journal analytics

Kept as long as needed, so the journal has to show what's worth keeping. Settings → AI Journal →
Analytics (and a panel on the AI page):

- **Chat ↔ notes map**: for each chat, the notes it wrote and the notes it read; for each note, the
  chats that wrote or read it.
- **Size**: per note, per folder, per project, per variant, over time.
- **Most used sections**: which notes and which headings inside them are read most — by the AI
  (search hits, reads) and by you (opened in Notes). Least used too.
- **Search quality**: searches with no results (gaps), searches whose result was then read (useful).
- **Checkpoints**: how often, tokens saved, and whether the task still succeeded afterwards.
- **Change hot spots**: files changed most, by whom (model/role), and how often changes were undone.
- **Per model / role**: tokens, time, swaps, checker pass rate, failures.
- **Variant comparison (A vs B)**: size, retrieval hit rate, tokens injected, task success,
  your 👍/👎 on answers.
- **Clean-up suggestions**: notes never read in 90 days, near-duplicates, oversized notes — offered,
  never done without you.

Access events (who read what, when) go in `AI Journal/.stats/<computer>.jsonl` so both computers add
to the same picture.

## 5. AI page redesign

Edge to edge, three panels:

- **Left — chats**: search, new chat, history; Memory, Skills, Files, Journal.
- **Center — conversation**: header with brain/team picker + live status, **context bar** (from 2)
  with **Summarize now**, Thinking. Plan/step cards with "changes" and "journal" links. Errors as
  fix-it cards ("Server isn't running → Start", "Model failed to load → Show why / Lower GPU share").
  Composer: attach, camera, BridgeDeck-tab chip (shows which tab, ✕ to drop), mic with its mode.
- **Right — status & team**: small orb with state; server running + Start/Stop; loaded model;
  **OK / Busy / Overloaded** (from 1); VRAM/RAM bars; speed sparkline; GPU share and context size
  editable; **Stop AI**. Team roles with model, loaded/idle/failing, fallback in use, check-each-step.
  Journal variant in use for this chat, analytics summary.

Hidden in Settings: model files/downloads, server path, listen address, autostart, keep-both-loaded,
voices and devices, API keys, engines, MCP servers, skill-pack installs, self-edit auto-approve,
safety overrides, persona, logs.

Open Mic guardrail: spoken text shows as a draft with "Sending in 3 s… Cancel"; optional wake word
("Mimir, …"); messages from the mic are marked 🎙.

## Also fix along the way

- PC models stay loaded forever when idle: add an idle unload (default 20 min) on the PC too.
- A model that fails to load doesn't use the role's fallback (only an unreachable server does).
- Errors like "fetch failed" when llama-swap isn't running: start it on demand (with autostart on) and
  say so in plain words.
