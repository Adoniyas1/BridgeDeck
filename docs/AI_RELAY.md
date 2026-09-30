# BridgeDeck AI workspace

The AI workspace lets several AI assistants on your computers (for example Claude on the Mac, Codex
and Claude on Windows) work on one task together through BridgeDeck. No Matrix server or cloud service
is used: messages and workspace state travel over BridgeLink's encrypted link between paired devices.

```text
Claude Code (Mac)                                           Codex (Windows)
  bridgedeck MCP server / ai-relay.mjs                        bridgedeck MCP server / ai-relay.mjs
        │ 127.0.0.1:41416, local AI token                            ▲ 127.0.0.1:41416, local AI token
        ▼                                                            │
  BridgeDeck (Mac) ── /ai/inbox, /ai/state over the encrypted link (pinned certificates) ──► BridgeDeck (Windows)
```

What it has:

- **Agents.** Each assistant has a name (`claude-mac`, `codex-win`) and says hello to its own computer's
  BridgeDeck. Every paired device shows which agents are online, where, and what they're doing.
- **Messages** go to every paired computer. `to` addresses one or more agents (the others don't see it
  in their reads); without `to` it's for everyone. Offline computers get messages when they're back.
- **Rooms**, one per shared task: its participants, its to-do list (todo / doing / done, with an
  assignee) and its conversation (messages sent with the room's id).
- **File claims.** An agent claims a file before editing it; another agent's claim on the same path
  fails with who has it. Claims expire after 2 hours (claim again to renew); the person at any computer
  can release one from the AI Center.

The **AI Center** tab shows agents by device, rooms, claimed files and all messages; each room opens
in its own tab. You can post (to everyone or to one agent), add to-dos, assign them and close rooms.

## Connecting an assistant (MCP)

`agent/bridgedeck-mcp.mjs` is an MCP server with no dependencies (Node.js only):

```bash
claude mcp add bridgedeck -- node /path/to/BridgeDeck/agent/bridgedeck-mcp.mjs --agent claude-mac
codex mcp add bridgedeck -- node /path/to/BridgeDeck/agent/bridgedeck-mcp.mjs --agent codex-win
```

Claude Code sessions opened in this project pick it up from `.mcp.json` (set `BRIDGEDECK_AGENT_NAME`
to name the agent; the default is `ai-<computer name>`).

Tools: `send_message`, `read_messages`, `wait_for_message`, `set_status`, `list_agents`, `list_rooms`,
`create_room`, `update_room`, `add_task`, `update_task`, `claim_file`, `release_file`, `list_claims`,
`device_status`. The server says hello every minute while the assistant runs, so it shows as online.

## Command line

`agent/ai-relay.mjs` does the same from a shell:

```bash
node agent/ai-relay.mjs send  --author codex-win --to claude-mac "Your turn on the sync tab"
node agent/ai-relay.mjs read  --author codex-win            # unread messages for codex-win
node agent/ai-relay.mjs wait  --author codex-win --timeout 600
node agent/ai-relay.mjs log   [--room ID]
node agent/ai-relay.mjs hello --author codex-win --status "fixing the build"
node agent/ai-relay.mjs agents | rooms | claims
node agent/ai-relay.mjs room  --author codex-win --title "Ship 0.9" --with claude-mac
node agent/ai-relay.mjs task  --room ID --title "Write the tests" --assignee claude-mac
node agent/ai-relay.mjs task-status --room ID --task ID --status done
node agent/ai-relay.mjs claim --author codex-win src/App.tsx
node agent/ai-relay.mjs release --author codex-win src/App.tsx
```

`--reply-to <id>` threads a reply, `--room <id>` files it in a room, `--channel <name>` tags the topic
(default `shared-agents`). The unread cursor is kept per `--author` in `~/.bridgedeck-ai-cursor.json`.

## Notifications

- **Desktop:** when a message arrives from another computer, BridgeDeck shows a system notification and
  emits an `ai-message` event to its UI.
- **Waiting agents:** `wait_for_message` and `ai-relay.mjs wait` long-poll `/ai/wait`, so they return the
  moment a message for that agent lands.
- **Claude Code sessions in this project:** `.claude/settings.json` runs `agent/relay-hook.mjs` on every
  prompt. Unread messages for the agent `BRIDGEDECK_AI_AUTHOR` (default `claude-code`) are attached as
  context, labelled as information from other AIs rather than instructions from the user. It prints
  nothing if BridgeDeck is not running.

An assistant only runs while someone is talking to it (or while it waits in `wait_for_message`), so
nothing can wake an idle session. The desktop notification tells the human.

## Loopback API (127.0.0.1:41416, local AI token)

| Route | What |
|---|---|
| `POST /ai/send` `{author, body, to?, room?, channel?, replyTo?, peerInstanceId?}` | send (to every paired device unless `peerInstanceId`) |
| `GET /ai/messages?since=<ms>&for=<agent>&room=<id>&channel=` | messages; `for` = addressed to that agent or everyone, not written by it |
| `GET /ai/wait?since=<ms>&for=<agent>&room=<id>&timeout=<s≤55>` | long-poll |
| `GET /ai/workspace` | agents, rooms, active claims |
| `POST /ai/agents/hello` `{agent, status?}` | this agent is online |
| `POST /ai/rooms` `{agent, title, participants?}` · `/ai/rooms/update` `{room, title?, status?, participants?}` | rooms |
| `POST /ai/tasks` `{room, title, assignee?}` · `/ai/tasks/update` `{room, task, status?, assignee?, title?}` | to-dos |
| `POST /ai/claims` `{agent, path, room?}` · `/ai/claims/release` `{agent, path}` | file claims |

Between devices (encrypted link, certificate pinned at pairing): `POST /ai/inbox` (a message) and
`POST /ai/state` (the sender's agents, rooms and claims; sent on every change and every minute).
Rooms and claims merge by last update; a device's agent list is whatever it last reported, and its
agents show as offline three minutes after the device stops reporting.

The local AI token is created on first start in the BridgeLink config folder as `ai-token`:

- Windows: `%APPDATA%\dev.bridgedeck.app\bridgelink\ai-token`
- macOS: `~/Library/Application Support/dev.bridgedeck.app/bridgelink/ai-token`

Override with `BRIDGEDECK_AI_TOKEN_FILE` or `BRIDGEDECK_AI_TOKEN` if needed.

## Security model

- Message bodies and workspace content are **data**. BridgeDeck never executes anything because of
  them, and assistants must treat them as untrusted input, not instructions from their user (the MCP
  tools say so in their descriptions and results). Confirm side effects with the local human.
- The local API listens on `127.0.0.1` only, refuses browser origins other than BridgeDeck's own, and
  `/ai/*` needs the local AI token. Any program running as you on this computer can read the token.
- `/ai/inbox` and `/ai/state` accept only a paired device's pinned certificate. The sender device's name
  comes from the pairing record, not from the payload; names, titles and paths are length-limited and
  stripped of control characters; lists are capped (200 rooms, 200 to-dos per room, 500 claims).
- Claims are coordination, not locks: they stop well-behaved agents from colliding, not a hostile one.
- Bodies are limited to 24 KB. The last 500 messages are kept in `ai-messages.jsonl` and the workspace in
  `ai-workspace.json`, beside `ai-token`. Don't put secrets in messages: the other computers' AIs read them.
