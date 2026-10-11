# Mimir

A desktop AI assistant with an animated face, an offline wake word, and one
genuinely unusual capability: it can read, propose, and apply changes to its
own source code, then restart into the new version — safely, with automatic
rollback if anything breaks.

Runs on macOS and Windows, inside [BridgeDeck](../README.md): Mimir is a Node
process that BridgeDeck installs, builds, starts and restarts, and its face,
chat and voice are BridgeDeck's **Mimir** tab. There is no separate window and
no Electron.

## Quick start

In BridgeDeck, open the **Mimir** tab and press **Set up Mimir** (it runs
`npm ci` and `npm run build` here once, then starts Mimir with BridgeDeck).

On its own, for development:

```bash
npm install
npm start          # builds, then prints MIMIR_LISTENING {"port":…,"token":…}
# open http://127.0.0.1:<port>/?token=<token>
```

Then open Settings (⚙, top right) and:

1. **Brain** — pick a provider and add credentials:
   - **Claude (Anthropic)** — paste an API key from console.anthropic.com. This is
     the default and the only provider currently able to drive self-editing
     reliably out of the box (see "Modular brain" below).
   - **Local model (Ollama)** — install [Ollama](https://ollama.com), pull a
     model (`ollama pull llama3.1:8b`), and just point Mimir at it. No key needed.
   - **Your own server / VPS** — any OpenAI-compatible endpoint (vLLM,
     text-generation-webui, llama.cpp server). Set the base URL and, if it
     needs one, an API key.
2. **Voice** (optional) — wake word needs a free Picovoice AccessKey from
   console.picovoice.ai, *and* a custom "Mimir" keyword file trained in that
   same console, dropped at `resources/wake-word/mimir_mac.ppn` (or
   `mimir_windows.ppn`). Without either, wake word is simply disabled and
   push-to-talk (the mic button) still works fully offline via local Whisper.

## ChatGPT section

The **CHATGPT** button opens a separate chat with OpenAI's models using your own
OpenAI API key (stored in the OS keychain; API use is billed by OpenAI, separately
from ChatGPT Plus). It is not Mimir's brain: no tools, no self-editing. Chats live
in `~/.mimir/chatgpt/`, and "Save to Notes" copies one into BridgeDeck's Notes.
Code: `src/main/chatgpt/`, `src/renderer/ChatGpt.tsx`.

## Modular brain

Every place in the app that talks to "the model" goes through one interface
(`src/main/brain/Provider.ts`). Three implementations exist today —
Anthropic, Ollama, and a generic OpenAI-compatible client for your own VPS —
and switching between them is a Settings action, not a rebuild. A provider
that can't do native tool-calling is transparently wrapped so it can still
use Mimir's tools via a prompt-based fallback (`src/main/brain/reactShim.ts`);
self-editing specifically stays gated to providers that report real
tool-calling support, so a weak local model degrades to "assistant that
can't edit itself" rather than a silently unsafe agent.

## Prompt modules

Mimir's system prompt is not one block. It is split into small modules in
`src/main/prompts/modules.ts` — one per capability, each with the few
sentences that explain it and the exact tools it brings. `src/main/prompts/loader.ts`
decides, per message, which modules to send:

- **Required:** only `core` (who Mimir is and the rules for every reply).
- **Optional:** loaded one at a time when the message needs them (memory,
  project files, calculations, skills, calendar, …) and while they fit a token
  budget; a module that matched stays for two more turns. Local (Ollama)
  models use this; cloud models get every module their tier allows.
- **Tools travel with their module**, so a model is never told about a tool it
  does not have, and a message like "hi" sends about 120 tokens instead of the
  ~3,500 the always-on prompt and tool list used to cost a 3B model.

The chat shows which modules were loaded for the last message, and
Skills → *What gets loaded* lists every module, when it loads and what it costs.
Mimir has no soul or identity file; `USER.md`, `MEMORY.md` and `TASKS.md`
hold only what it learns.

## Brain team

Instead of one model doing everything, Settings → **Brain team** can split the work:

- **Head** plans and writes the reply; **Executor** does the steps with tools; **Checker** reviews
  each result (by default the Head does this too).
- A message that needs no tools goes straight to the Head (one call). Otherwise the Head writes a
  short plan, the Executor runs each step with only that step's prompt modules, and the Checker
  passes it or sends it back with feedback — twice at most, then the Head does the step itself.
- With "check each step" off, all steps are reviewed together at the end, so a small machine swaps
  models a few times per task instead of twice per step.
- Each role has a server to try first and a fallback, so the Mac can use the Windows PC's models
  when it's on and its own MLX models when it isn't. Settings are per computer (`~/.mimir/team.json`).

The loop is a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) graph run inside Mimir's own
process (`src/main/team/graph.ts`); the plan and each step show above the reply in the chat.

## Tool servers (MCP)

Settings → **Tool servers (MCP)** adds any [Model Context Protocol](https://github.com/modelcontextprotocol/servers)
server (stdio). Mimir starts it, lists its tools and offers them like its own, named
`mcp_<server>_<tool>`. Each server is a prompt module: its tools load when a message mentions the
server or one of its keywords, or when a Brain-team plan names it. Presets: Filesystem (limited to
Projects), Fetch, Git and Sequential thinking.

Tools a server marks read-only run straight away; anything else shows an **Allow / Deny** card in the
chat first, unless the server is marked trusted. Servers are per computer (`~/.mimir/mcp.json`).

## Coding tools

A **Coding** prompt module gives Mimir tools shaped like Claude Code's — `Read` (numbered lines),
`Write`, `Edit` (exact-text replace), `Glob`, `Grep`, `Bash`, `WebFetch` and `TodoWrite` — working in
a coding folder set in Settings (Projects by default). `Bash` always asks first; `Write`/`Edit` ask
for any file outside Projects; reads outside the coding folder and Projects ask too. They load when a
message is about code, or when a Brain-team plan names the `coding` module.

## Claude Code and OpenCode

Settings → **Brain team** picks who runs the chat: **Mimir**, **Claude Code** or **OpenCode**. The
outside agents run headless inside Mimir (no terminal or extra window), in the coding folder, with
their own tools, and keep the conversation going between messages.

- **Models:** the team's Head (main model) and Executor (small, fast model) — the PC's when it
  answers, this computer's when it doesn't — or the agent's own models and login.
- **Claude Code** (`claude -p --output-format stream-json`) talks to a small Anthropic-to-OpenAI
  bridge Mimir starts on 127.0.0.1 (`src/main/engines/anthropicBridge.ts`), so it works with
  llama-swap, llama.cpp, MLX servers and Ollama without LiteLLM. Its permission prompts go through an
  MCP tool (`--permission-prompt-tool`) back to Mimir.
- **OpenCode** runs as `opencode acp` (the Agent Client Protocol over stdio); its permission requests
  come back the same way. The team's models are passed in as OpenAI-compatible providers.
- Both ask, with the same **Allow / Deny** card, before every command and every file change outside
  Projects. Install them with `npm install -g @anthropic-ai/claude-code` / `npm install -g opencode-ai`,
  or set the command's path in Settings.

## Model servers

Settings → **Model servers** gets the Brain team's models running without a terminal. Mimir
uses [llama-swap](https://github.com/mostlygeek/llama-swap) in front of llama.cpp's `llama-server`,
writes `~/.mimir/llama-swap.yaml`, runs llama-swap in the background (optionally whenever Mimir
starts), warms each model up, and applies the matching Brain-team preset. Programs it downloads go
in `~/.mimir/bin`.

- **Mac (8 GB):** the GGUF files and llama-server already in `~/Bonsai-demo` are used as they are
  (PrismML's build, which reads Ternary Bonsai's PQ2_0 files; Mimir downloads it if missing).
  Qwen3.5-9B **IQ3_XXS** is the Head, Ternary Bonsai 8B (PQ2_0) the Executor, one loaded at a time
  with an 8K context and a 4-bit KV cache, each unloaded after 10 idle minutes. Before a model loads,
  a **memory guard** checks free memory (vm_stat) and refuses with what to close instead of letting
  the Mac run out. The old MLX downloads can be deleted under **Disk space**.
- **Windows PC (RTX 4070 Ti 12 GB, 16 GB RAM):** `llama-server -hf …` — Qwen3.5-35B-A3B
  (`UD-Q4_K_XL`, part of its experts in RAM with `--n-cpu-moe`) as Head, Qwen3.5-9B (`Q4_K_M`) as
  Executor. With 16 GB of RAM they take turns; "Keep both models loaded" uses a llama-swap group
  instead. It listens on `0.0.0.0:8080` so the Mac can use it (allow it through Windows Firewall).

Each model's file or source and its server arguments can be changed in the same panel. Every chat
turn is logged to `~/.mimir/logs/<date>.md` (model calls, timings, prompt sizes, tools, errors).

## How self-editing works

Read `src/main/self-edit/transaction.ts` for the details — the short version:

- Mimir's editable source lives in a **workspace** copy under
  `~/.mimir/workspace` (never the original install), tracked by its own git repo.
- Every edit is a transaction: checkpoint → write → typecheck/test → commit,
  or on any failure, `git reset --hard` back to the checkpoint. Nothing
  partially-applied ever survives.
- "Skill" edits (new files under `skills/`) apply immediately after a fast
  typecheck. "Core" edits (anything under `src/main` or `src/renderer`) need
  a full verify pass and — unless you've turned on auto-approve — your
  explicit sign-off in the UI before Mimir restarts into them.
- A tiny **immutable entry point** (`server-entry.mjs`, never part of the
  editable workspace) decides which build to actually launch, and reverts to
  the original install automatically after 3 consecutive failed boots.
  Restarting into a new build is exit code 75, which BridgeDeck answers by
  starting Mimir again. `supervisor/` has the same logic as a standalone
  watchdog for running Mimir without BridgeDeck.

## How it runs inside BridgeDeck

- `src/main/server.ts` serves the built renderer on 127.0.0.1 and carries the
  channels Electron's IPC used (`IPC` in `src/shared/types.ts`) over a
  WebSocket. The renderer's `src/renderer/bridge.ts` is the matching
  `window.mimir`. The connection needs the token BridgeDeck passes in
  (`MIMIR_TOKEN`) and only BridgeDeck's tab is given.
- On stdout Mimir prints `MIMIR_LISTENING`, `MIMIR_HEALTHY` and
  `MIMIR_NOTIFY` lines; BridgeDeck shows the tab when Mimir is listening and
  turns notifications into native ones (`src-tauri/src/mimir_host.rs`).
- The voice hotkey (⌘/Ctrl+Shift+Space) is registered by BridgeDeck and
  forwarded to the page with `postMessage`.
- Data stays where the Electron build kept it (an existing workspace there is
  used); new installs keep it under `~/.mimir/app`.
- Every applied edit is in an audit log you can browse and one-click revert.

## Development

```bash
npm run typecheck   # main + renderer + supervisor
npm test            # transaction engine + boot-policy unit tests
npm run lint
```
# mimir
