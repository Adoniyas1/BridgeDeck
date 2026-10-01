import type { ToolDef, ToolResult, Toolset } from "../brain/Provider.js";
import type { BridgeDeckClient } from "./client.js";
import { occurrences, type CalEvent, type CalRepeat } from "./recur.js";

/** The longest tool answer handed back to the model. */
const MAX_ANSWER = 12_000;

/** "2026-10-03", "2026-10-03T15:00" (this computer's time) or a full ISO time with a zone. */
export function parseTime(value: unknown): { ms: number; dateOnly: boolean } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  if (dateOnly) {
    const [y, m, d] = text.split("-").map(Number) as [number, number, number];
    return { ms: new Date(y, m - 1, d).getTime(), dateOnly };
  }
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? null : { ms, dateOnly: false };
}

export function when(ms: number, allDay = false): string {
  const date = new Date(ms);
  const day = date.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  return allDay ? day : `${day} ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** UTC, as BridgeDeck writes due times in checklist Markdown. */
function dueTag(ms: number) {
  return ` (due ${new Date(ms).toISOString().slice(0, 16)}Z)`;
}

const ok = (content: string): ToolResult => ({ content: content.length > MAX_ANSWER ? `${content.slice(0, MAX_ANSWER)}\n…(cut short)` : content });
const fail = (error: unknown): ToolResult => ({ content: error instanceof Error ? error.message : String(error), isError: true });
const str = (input: Record<string, unknown>, key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");

const REPEATS: Record<string, CalRepeat> = {
  daily: { freq: "daily", interval: 1, days: [], until: null, count: null },
  weekdays: { freq: "weekly", interval: 1, days: [1, 2, 3, 4, 5], until: null, count: null },
  weekly: { freq: "weekly", interval: 1, days: [], until: null, count: null },
  monthly: { freq: "monthly", interval: 1, days: [], until: null, count: null },
  yearly: { freq: "yearly", interval: 1, days: [], until: null, count: null }
};

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });

/** Mimir's hands in BridgeDeck: notes and checklists, the calendar, Messages, the
 * other computer, files, the clipboard and AI rooms. Sending a message or files
 * makes BridgeDeck ask the person first; everything else is the person's own
 * data on their own computers. */
export function buildBridgeDeckToolset(client: BridgeDeckClient): Toolset {
  const defs: ToolDef[] = [
    { name: "notes_search", description: "Search the user's BridgeDeck notes and checklists (shared between their computers). Empty query lists the most recent. Returns ids for note_read.", inputSchema: object({ query: s("Words to find; all must match") }) },
    { name: "note_read", description: "Read a BridgeDeck note or checklist as Markdown (checklist items as - [ ] / - [x], sub-tasks indented two spaces, due times in UTC).", inputSchema: object({ id: s("Note id from notes_search") }, ["id"]) },
    { name: "note_create", description: "Create a BridgeDeck note or checklist from Markdown. Checklist items: '- [ ] text'; a sub-task is indented two spaces under its task. Use checklist=true for to-do lists.", inputSchema: object({ title: s("Title"), markdown: s("Content as Markdown"), folder: s("Optional folder"), checklist: { type: "boolean" } }, ["title", "markdown"]) },
    { name: "note_append", description: "Add Markdown to the end of a BridgeDeck note or checklist (e.g. '- [ ] New item').", inputSchema: object({ id: s("Note id"), markdown: s("Markdown to add") }, ["id", "markdown"]) },
    { name: "checklist_add", description: "Add an item to a BridgeDeck checklist, optionally with a due time (it then shows in the calendar and reminds the user).", inputSchema: object({ id: s("Checklist note id"), item: s("The item's text"), due: s("Optional due time: 2026-10-03T15:00 (this computer's time) or 2026-10-03") }, ["id", "item"]) },
    { name: "checklist_tick", description: "Tick (or untick) a checklist item by its text; its sub-tasks follow.", inputSchema: object({ id: s("Checklist note id"), item: s("The item's text (or a distinctive part of it)"), done: { type: "boolean", description: "false to untick" } }, ["id", "item"]) },
    { name: "calendar_list", description: "List the user's BridgeDeck calendar events (repeats expanded) between two dates. Defaults to today and the next 7 days.", inputSchema: object({ from: s("Start date, e.g. 2026-10-01"), to: s("End date (exclusive)") }) },
    { name: "calendar_add", description: "Add an event to the user's BridgeDeck calendar (synced to their other computer). Times are this computer's local time unless they carry a zone.", inputSchema: object({ title: s("Title"), start: s("2026-10-03T15:00, or 2026-10-03 for an all-day event"), end: s("Optional end; default 1 hour (or 1 day)"), repeat: { type: "string", enum: ["daily", "weekdays", "weekly", "monthly", "yearly"] }, reminderMinutes: { type: "number", description: "Remind this many minutes before" }, location: s("Optional"), notes: s("Optional") }, ["title", "start"]) },
    { name: "calendar_delete", description: "Delete a BridgeDeck calendar event (the whole series if it repeats).", inputSchema: object({ id: s("Event id from calendar_list") }, ["id"]) },
    { name: "messages_chats", description: "List recent iMessage/SMS conversations (from the user's Mac) with their chat ids.", inputSchema: object({ limit: { type: "number" } }) },
    { name: "messages_read", description: "Read the latest messages in one conversation.", inputSchema: object({ chat: s("Chat id from messages_chats"), limit: { type: "number" } }, ["chat"]) },
    { name: "message_send", description: "Send an iMessage/SMS from the user's Mac. BridgeDeck shows the user the exact text and recipient and sends only if they approve.", inputSchema: object({ chat: s("Chat id from messages_chats"), text: s("The message"), to: s("Who it's to, as shown to the user") }, ["chat", "text"]) },
    { name: "computers_status", description: "The user's paired computers: online or not, version, and whether they can be woken.", inputSchema: object({}) },
    { name: "computer_wake", description: "Wake a sleeping paired computer (Wake-on-LAN, same network).", inputSchema: object({ computer: s("Its name") }, ["computer"]) },
    { name: "files_send", description: "Send files or folders from this computer to a paired computer. BridgeDeck asks the user first.", inputSchema: object({ computer: s("Its name"), paths: { type: "array", items: { type: "string" }, description: "Absolute paths" } }, ["computer", "paths"]) },
    { name: "clipboard_read", description: "Read the text on this computer's clipboard.", inputSchema: object({}) },
    { name: "clipboard_write", description: "Put text on the clipboard (it also reaches the paired computer when clipboard sharing is on).", inputSchema: object({ text: s("Text") }, ["text"]) },
    { name: "ai_rooms", description: "The AI workspace: rooms, tasks and agents on the user's computers.", inputSchema: object({}) },
    { name: "ai_post", description: "Post a message as Mimir in an AI room (other agents on the user's computers read it).", inputSchema: object({ room: s("Room id"), text: s("Message") }, ["text"]) }
  ];

  const call = client.call.bind(client);
  const handlers: Toolset["handlers"] = {
    notes_search: async (input) => {
      try {
        const found = await call<Array<{ id: string; title: string; folder: string; kind: string; preview: string }>>("notes/search", { query: str(input, "query") });
        if (!found.length) return ok("No notes match.");
        return ok(found.map((n) => `- ${n.title} [${n.kind === "list" ? "checklist" : "note"}${n.folder ? `, ${n.folder}` : ""}] id=${n.id}${n.preview ? ` — ${n.preview}` : ""}`).join("\n"));
      } catch (error) { return fail(error); }
    },
    note_read: async (input) => {
      try {
        const note = await call<{ title: string; folder: string; markdown: string }>("notes/read", { id: str(input, "id") });
        return ok(`# ${note.title || "(untitled)"}${note.folder ? ` (folder: ${note.folder})` : ""}\n\n${note.markdown}`);
      } catch (error) { return fail(error); }
    },
    note_create: async (input) => {
      try {
        const created = await call<{ id: string }>("notes/create", { title: str(input, "title"), markdown: str(input, "markdown"), folder: str(input, "folder"), kind: input.checklist ? "list" : "note" });
        return ok(`Created in BridgeDeck Notes (id=${created.id}).`);
      } catch (error) { return fail(error); }
    },
    note_append: async (input) => {
      try {
        await call("notes/append", { id: str(input, "id"), markdown: str(input, "markdown") });
        return ok("Added.");
      } catch (error) { return fail(error); }
    },
    checklist_add: async (input) => {
      const item = str(input, "item").replace(/\n/g, " ").trim();
      if (!item) return fail("The item needs text.");
      let tag = "";
      if (input.due !== undefined && input.due !== "") {
        const due = parseTime(input.due);
        if (!due) return fail("I couldn't read that due time; use 2026-10-03T15:00.");
        tag = dueTag(due.dateOnly ? due.ms + 9 * 3_600_000 : due.ms);
      }
      try {
        await call("notes/append", { id: str(input, "id"), markdown: `- [ ] ${item}${tag}` });
        return ok(`Added “${item}”${tag ? `, due ${when(parseTime(input.due)!.ms, parseTime(input.due)!.dateOnly)}` : ""}.`);
      } catch (error) { return fail(error); }
    },
    checklist_tick: async (input) => {
      try {
        const result = await call<{ changed: number }>("checklist/set", { id: str(input, "id"), item: str(input, "item"), done: input.done !== false });
        return ok(`${input.done === false ? "Unticked" : "Ticked"} ${result.changed} item${result.changed === 1 ? "" : "s"}.`);
      } catch (error) { return fail(error); }
    },
    calendar_list: async (input) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const from = parseTime(input.from)?.ms ?? today.getTime();
      const to = parseTime(input.to)?.ms ?? from + 7 * 86_400_000;
      try {
        const events = await call<CalEvent[]>("calendar/events");
        const items = events.flatMap((event) => occurrences(event, from, to).map((o) => ({ event, ...o }))).sort((a, b) => a.start - b.start);
        if (!items.length) return ok(`Nothing in the calendar from ${when(from, true)} to ${when(to - 1, true)}.`);
        return ok(items.map(({ event, start, end }) => `- ${when(start, event.allDay)}${event.allDay ? "" : `–${new Date(end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}: ${event.title || "(untitled)"}${event.location ? ` @ ${event.location}` : ""}${event.repeat ? " (repeats)" : ""} id=${event.id}`).join("\n"));
      } catch (error) { return fail(error); }
    },
    calendar_add: async (input) => {
      const start = parseTime(input.start);
      if (!start) return fail("I couldn't read the start time; use 2026-10-03T15:00 or 2026-10-03.");
      const end = parseTime(input.end);
      const allDay = start.dateOnly;
      const repeat = typeof input.repeat === "string" ? REPEATS[input.repeat] ?? null : null;
      const reminder = typeof input.reminderMinutes === "number" ? Math.max(0, Math.round(input.reminderMinutes)) : allDay ? null : 10;
      const event = {
        title: str(input, "title"), start: start.ms,
        end: end ? (allDay ? end.ms + 86_400_000 : end.ms) : start.ms + (allDay ? 86_400_000 : 3_600_000),
        allDay, location: str(input, "location"), notes: str(input, "notes"), repeat, skip: [], reminder
      };
      if (event.end < event.start) return fail("It ends before it starts.");
      try {
        const saved = await call<{ id: string }>("calendar/add", event);
        return ok(`Added “${event.title}” on ${when(event.start, allDay)}${repeat ? `, repeating ${input.repeat}` : ""} (id=${saved.id}).`);
      } catch (error) { return fail(error); }
    },
    calendar_delete: async (input) => {
      try { return ok((await call<boolean>("calendar/delete", { id: str(input, "id") })) ? "Deleted." : "That event was already gone."); } catch (error) { return fail(error); }
    },
    messages_chats: async (input) => {
      try { return ok(JSON.stringify(await call("messages", { op: "chats", limit: input.limit ?? 30 }))); } catch (error) { return fail(error); }
    },
    messages_read: async (input) => {
      try { return ok(JSON.stringify(await call("messages", { op: "messages", chat: str(input, "chat"), limit: input.limit ?? 30 }))); } catch (error) { return fail(error); }
    },
    message_send: async (input) => {
      try {
        await call("messages/send", { chat: str(input, "chat"), text: str(input, "text"), to: str(input, "to") });
        return ok("Sent (the user approved it).");
      } catch (error) { return fail(error); }
    },
    computers_status: async () => {
      try {
        const list = await call<Array<{ name: string; platform: string; online: boolean; wakeable: boolean; version?: string }>>("computers");
        if (!list.length) return ok("No paired computers.");
        return ok(list.map((c) => `- ${c.name} (${c.platform}): ${c.online ? `online${c.version ? `, BridgeDeck ${c.version}` : ""}` : `offline${c.wakeable ? ", can be woken" : ""}`}`).join("\n"));
      } catch (error) { return fail(error); }
    },
    computer_wake: async (input) => {
      try { return ok(await call<string>("computers/wake", { computer: str(input, "computer") })); } catch (error) { return fail(error); }
    },
    files_send: async (input) => {
      const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string") : [];
      if (!paths.length) return fail("Give at least one path.");
      try {
        const started = await call<{ transfer: string }>("files/send", { computer: str(input, "computer"), paths });
        return ok(`Sending (the user approved it); it shows under Transfers in BridgeDeck's Files tab. Transfer id ${started.transfer}.`);
      } catch (error) { return fail(error); }
    },
    clipboard_read: async () => {
      try { return ok((await call<string>("clipboard/get")) || "(the clipboard has no text)"); } catch (error) { return fail(error); }
    },
    clipboard_write: async (input) => {
      try { await call("clipboard/set", { text: str(input, "text") }); return ok("Copied."); } catch (error) { return fail(error); }
    },
    ai_rooms: async () => {
      try { return ok(JSON.stringify(await call("ai/rooms"))); } catch (error) { return fail(error); }
    },
    ai_post: async (input) => {
      try { await call("ai/post", { room: str(input, "room") || undefined, text: str(input, "text") }); return ok("Posted."); } catch (error) { return fail(error); }
    }
  };
  return { defs, handlers };
}

/** Tools small local models also get: the everyday ones. */
export const BRIDGEDECK_CORE_TOOLS = ["notes_search", "note_read", "checklist_add", "checklist_tick", "calendar_list", "calendar_add"];
