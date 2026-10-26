import type { ToolDef, ToolResult, Toolset } from "../brain/Provider.js";
import type { BridgeDeckClient } from "./client.js";
import { occurrences, type CalEvent, type CalRepeat } from "./recur.js";
import { visionReading, withReading } from "../team/vision.js";

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
 * other computer, files, the clipboard, AI rooms, the user's textbooks and projects. Sending a message or files
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
    { name: "computer_look", description: "See the screen of one of the user's paired computers (a screenshot you can look at), e.g. to tell them what's on it or guide them step by step. Look only: you can't click or type there. BridgeDeck asks the user first, and the other computer shows that Mimir is viewing.", inputSchema: object({ computer: s("Its name"), monitor: { type: "number", description: "Screen number, 0 for the main one" } }, ["computer"]) },
    { name: "computer_wake", description: "Wake a sleeping paired computer (Wake-on-LAN, same network).", inputSchema: object({ computer: s("Its name") }, ["computer"]) },
    { name: "files_send", description: "Send files or folders from this computer to a paired computer. BridgeDeck asks the user first.", inputSchema: object({ computer: s("Its name"), paths: { type: "array", items: { type: "string" }, description: "Absolute paths" } }, ["computer", "paths"]) },
    { name: "clipboard_read", description: "Read the text on this computer's clipboard.", inputSchema: object({}) },
    { name: "clipboard_write", description: "Put text on the clipboard (it also reaches the paired computer when clipboard sharing is on).", inputSchema: object({ text: s("Text") }, ["text"]) },
    { name: "daily_brief", description: "The user's day at a glance from BridgeDeck: today's events, checklist items due or overdue, exams and project milestones in the next week, and flashcards to review. Use it for 'what's my day', 'what's due', 'what should I study'.", inputSchema: object({}) },
    { name: "study_courses", description: "The user's Study courses in BridgeDeck: their textbooks (and whether each is searchable), course notes and checklists (ids for note_read), and flashcard counts.", inputSchema: object({}) },
    { name: "study_assignments", description: "The user's assignments, quizzes and labs from Canvas and ones they added by hand, with due times and whether each is done. Use it for 'what's due', 'what homework do I have', planning the week.", inputSchema: object({ course: s("Optional course name"), include_done: { type: "boolean", description: "Also list finished ones (default false)" } }) },
    { name: "study_grades", description: "The user's grade in each course, worked out from their grade sheets in BridgeDeck (by category, with the goal they set) and Canvas's grade. Use it for 'how am I doing', 'what do I need on the final'.", inputSchema: object({ course: s("Optional course name") }) },
    { name: "study_schedule", description: "The user's class times for the next days (room, cancelled or moved classes, breaks), from BridgeDeck's Study tab.", inputSchema: object({ days: { type: "number", description: "Days ahead (default 7, max 30)" } }) },
    { name: "study_plan", description: "The study blocks BridgeDeck's planner put in the calendar for the next days, and what each is for.", inputSchema: object({ days: { type: "number", description: "Days ahead (default 7)" } }) },
    { name: "study_plan_make", description: "Plan study time: BridgeDeck's study planner fits the hours each assignment and exam in the next four weeks needs into the user's free time (around classes and events) and puts the blocks in the calendar, replacing the last plan's blocks still ahead. Use it when they ask to plan their week or their studying, or agree to it. Says what was added and anything that didn't fit.", inputSchema: object({}) },
    { name: "study_search", description: "Search the user's textbooks page by page. Use it before answering a study question, and cite what you use as (Book, p. N). Each hit has a link for notes: [Book, p. N](link) opens the book at that page.", inputSchema: object({ query: s("What to look for (key terms work best)"), course: s("Optional course name to search only its books"), limit: { type: "number", description: "Hits to return (default 8, max 30)" } }, ["query"]) },
    { name: "study_read", description: "Read pages of one of the user's textbooks (up to 8 at a time), e.g. a whole section for a summary, quiz or step-by-step explanation. Page numbers are the PDF's pages, as study_search gives them.", inputSchema: object({ course: s("Course name"), book: s("Book title or file name"), from: { type: "number", description: "First page" }, to: { type: "number", description: "Last page (at most from + 7)" } }, ["course", "book", "from"]) },
    { name: "study_photo", description: "Look at a photo saved in one of the user's courses (a homework sheet, a whiteboard, a page of notes). The picture is attached for you to read.", inputSchema: object({ course: s("Course name"), file: s("The photo's file name in the course") }, ["course", "file"]) },
    { name: "study_lecture", description: "The user's lecture recordings in a course, or one lecture's transcript with [mm:ss] times, the moments they marked as lost, and the id of its note (for notes_append).", inputSchema: object({ course: s("Course name"), file: s("Optional: the recording's file name, for its transcript") }, ["course"]) },
    { name: "study_syllabus", description: "Suggest a course's setup from its syllabus: grade weights, people with office hours, exams and the AI policy. It waits in BridgeDeck's Study tab, showing what would change, until the user accepts.", inputSchema: object({ course: s("Course name"), weights: { type: "array", items: object({ name: s("Category, e.g. Homework"), weight: { type: "number", description: "Percent of the grade" } }, ["name", "weight"]) }, people: { type: "array", items: object({ role: s("Professor, TA…"), name: s("Name"), email: s("Email"), hours: s("Office hours and room") }, ["name"]) }, exams: { type: "array", items: object({ title: s("Midterm 1, Final…"), when: s("2026-10-20T10:00 (this computer's time)"), room: s("Room (optional)"), covers: s("What it covers (optional)") }, ["title", "when"]) }, ai_policy: { type: "string", enum: ["none", "hints", "full"], description: "What the syllabus allows" } }, ["course"]) },
    { name: "study_suggest", description: "Suggest a deadline (homework, lab, project) or an exam for a course. It waits in BridgeDeck's Study tab under 'From Mimir' until the user adds it; tell them that.", inputSchema: object({ kind: { type: "string", enum: ["deadline", "exam"], description: "deadline or exam" }, course: s("Course name"), title: s("What it is, e.g. 'Problem set 5' or 'Midterm 2'"), when: s("Due time or exam start: 2026-10-03T15:00 (this computer's time) or 2026-10-03"), room: s("Exam room (optional)"), covers: s("What the exam covers (optional)"), allowed: s("What may be brought (optional)") }, ["kind", "course", "title"]) },
    { name: "flashcards_add", description: "Suggest flashcards for a course's deck in BridgeDeck; they wait in the Study tab under 'From Mimir' until the user adds them, then are reviewed with spaced repetition. Keep each side short and one idea per card. Give book and page when a card comes from a textbook.", inputSchema: object({ course: s("Course name"), cards: { type: "array", items: object({ front: s("Question"), back: s("Answer"), book: s("Optional book title"), page: { type: "number" } }, ["front", "back"]) } }, ["course", "cards"]) },
    { name: "projects_list", description: "The user's BridgeDeck projects: each one's folder (the same folder list_project_files and read_project_file work in), notes (ids for note_read), task board columns with their cards, and upcoming milestones.", inputSchema: object({}) },
    { name: "project_task_add", description: "Add a task card to a project's board in BridgeDeck (made with To do / Doing / Done columns if it has none). Optional due time shows it in the calendar.", inputSchema: object({ project: s("Project name"), task: s("The task"), column: s("Optional column; default the first (To do)"), due: s("Optional due time: 2026-10-03T15:00 or 2026-10-03") }, ["project", "task"]) },
    { name: "project_task_move", description: "Move a task card on a project's board to another column (e.g. Doing, Done); moving to Done ticks it.", inputSchema: object({ project: s("Project name"), task: s("The card's text (or a distinctive part)"), column: s("Column to move it to") }, ["project", "task", "column"]) },
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
    computer_look: async (input) => {
      try {
        const shot = await call<{ width: number; height: number; jpeg: string }>("computers/look", { computer: str(input, "computer"), monitor: typeof input.monitor === "number" ? input.monitor : 0 });
        return { content: `Screenshot of ${str(input, "computer")}: ${shot.width}×${shot.height} pixels (attached for you to look at).`, modelImages: [{ mimeType: "image/jpeg", data: shot.jpeg }] };
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
    daily_brief: async () => {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      const today = day.getTime();
      const tomorrow = today + 86_400_000;
      try {
        const [events, due, study, projects] = await Promise.all([
          call<CalEvent[]>("calendar/events"),
          call<Array<{ note: string; text: string; due: number }>>("notes/due"),
          call<{ courses: Array<{ name: string; flashcardsDue: number }> }>("study/courses").catch(() => ({ courses: [] })),
          call<{ projects: Array<{ name: string }> }>("projects/list").catch(() => ({ projects: [] }))
        ]);
        const courses = study.courses.map((c) => c.name);
        const isLog = (title: string) => courses.some((c) => title === `Studied ${c}`);
        const todays = events.flatMap((e) => occurrences(e, today, tomorrow).map((o) => ({ e, ...o }))).filter(({ e }) => !isLog(e.title)).sort((a, b) => a.start - b.start);
        const soon = events.flatMap((e) => occurrences(e, tomorrow, today + 8 * 86_400_000).map((o) => ({ e, ...o })))
          .filter(({ e }) => !isLog(e.title) && [...courses, ...projects.projects.map((p) => p.name)].some((n) => e.title.toLowerCase().includes(n.toLowerCase())))
          .sort((a, b) => a.start - b.start);
        const dueNow = due.filter((d) => d.due < tomorrow && Date.now() - d.due < 14 * 86_400_000);
        const cards = study.courses.filter((c) => c.flashcardsDue > 0);
        const lines = [
          `# ${when(today, true)}`,
          todays.length ? `Today:\n${todays.map(({ e, start, end }) => `- ${e.allDay ? "All day" : `${new Date(start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}–${new Date(end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`}: ${e.title}`).join("\n")}` : "Today: nothing in the calendar.",
          dueNow.length ? `Due:\n${dueNow.map((d) => `- ${d.text} (${d.note}) ${d.due < Date.now() ? "OVERDUE since" : "by"} ${when(d.due)}`).join("\n")}` : "Due: nothing today.",
          soon.length ? `Coming up:\n${soon.map(({ e, start }) => `- ${when(start, e.allDay)}: ${e.title}`).join("\n")}` : "",
          cards.length ? `Flashcards to review: ${cards.map((c) => `${c.name} ${c.flashcardsDue}`).join(", ")}` : ""
        ];
        return ok(lines.filter(Boolean).join("\n\n"));
      } catch (error) { return fail(error); }
    },
    study_courses: async () => {
      try {
        const { courses } = await call<{ courses: Array<{ name: string; books: Array<{ title: string; kind: string; searchable: boolean; pages: number | null }>; notes: Array<{ id: string; title: string; kind: string }>; flashcards: number; flashcardsDue: number }> }>("study/courses");
        if (!courses.length) return ok("No courses yet; the user adds them in BridgeDeck's Study tab.");
        return ok(courses.map((c) => [
          `## ${c.name}`,
          ...c.books.map((b) => `- Book: ${b.title} (${b.kind.toUpperCase()}${b.pages ? `, ${b.pages} pages` : ""}${b.searchable ? "" : ", not searchable yet"})`),
          ...c.notes.map((n) => `- ${n.kind === "list" ? "Checklist" : "Note"}: ${n.title} id=${n.id}`),
          `- Flashcards: ${c.flashcards} (${c.flashcardsDue} to review)`
        ].join("\n")).join("\n\n"));
      } catch (error) { return fail(error); }
    },
    study_assignments: async (input) => {
      try {
        const list = await call<Array<{ course: string; title: string; kind: string; due: number | null; points?: number | null; score?: number | null; done: boolean; missing?: boolean; source: string }>>("study/assignments", { course: str(input, "course") || undefined });
        const now = Date.now();
        // Done ones only when asked; old ones (two weeks overdue) drop off as on the Study tab.
        const shown = list.filter((a) => (input.include_done === true || !a.done) && (a.due == null || a.due > now - 14 * 86_400_000));
        if (!shown.length) return ok(list.length ? "Nothing left to do." : "No assignments: Canvas isn't connected and none were added by hand.");
        return ok(shown.slice(0, 60).map((a) => `- ${a.course ? `${a.course}: ` : ""}${a.title}${a.kind !== "assignment" ? ` (${a.kind})` : ""} — ${a.due == null ? "no due date" : `${a.due < now && !a.done ? "OVERDUE since " : "due "}${when(a.due)}`}${a.done ? " — done" : ""}${a.missing ? " — Canvas says missing" : ""}${a.score != null && a.points ? ` — ${a.score}/${a.points}` : ""}`).join("\n"));
      } catch (error) { return fail(error); }
    },
    study_grades: async (input) => {
      try {
        type Grade = { percent: number | null; letter: string | null; goal: number | null; categories: Array<{ name: string; weight: number; percent: number | null; items: Array<{ name: string; got: number | null; max: number }> }>; canvas: { score: number | null; grade: string } | null };
        const courses = await call<Array<{ course: string; grade: Grade }>>("study/grades", { course: str(input, "course") || undefined });
        if (!courses.length) return ok("No courses match.");
        return ok(courses.map(({ course, grade: g }) => [
          `## ${course}: ${g.percent == null ? "no grades entered yet" : `${g.percent}% (${g.letter})`}${g.goal ? `, goal ${g.goal}%` : ""}${g.canvas?.score != null ? `; Canvas says ${g.canvas.score}%${g.canvas.grade ? ` ${g.canvas.grade}` : ""}` : ""}`,
          ...g.categories.map((c) => `- ${c.name}${c.weight ? ` (${c.weight}%)` : ""}: ${c.percent == null ? "nothing graded" : `${c.percent}%`}; ${c.items.map((i) => `${i.name} ${i.got == null ? "not graded" : `${i.got}/${i.max}`}`).join(", ")}`)
        ].join("\n")).join("\n\n"));
      } catch (error) { return fail(error); }
    },
    study_schedule: async (input) => {
      try {
        const data = await call<{ term: { start: string; end: string; breaks: Array<{ start: string; end: string; name: string }> } | null; courses: Array<{ course: string; meetings: Array<{ days: number[]; start: string; end: string; room: string; kind: string }>; changes: Array<{ date: string; cancelled?: boolean; room?: string; note?: string }> }> }>("study/schedule");
        const days = Math.min(30, Math.max(1, typeof input.days === "number" ? Math.round(input.days) : 7));
        const lines = classDays(data, new Date(), days);
        return ok(lines.length ? lines.join("\n") : "No classes in that time (no class times are set, or it's a break).");
      } catch (error) { return fail(error); }
    },
    study_plan_make: async () => {
      try {
        const r = await call<{ added: number; replaced: number; blocks: Array<{ title: string; start: number; end: number }>; short: Array<{ task: string; hours: number }>; warnings: string[] }>("study/plan/make");
        if (!r.added) return ok("Nothing to plan: no assignments or exams with hours left in the next four weeks.");
        const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        const lines = r.blocks.map((b) => `- ${when(b.start)}–${new Date(b.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${b.title}`);
        const short = r.short.map((s) => `- ${s.task}: ${s.hours} h didn't fit before it's due`);
        return ok([`Added ${r.added} study block${r.added === 1 ? "" : "s"} to the calendar${r.replaced ? ` (replacing ${r.replaced} from the last plan)` : ""}:`, ...lines, ...(short.length ? ["", "Didn't fit:", ...short] : []), ...(r.warnings.length ? ["", ...r.warnings] : [])].join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
    study_plan: async (input) => {
      try {
        const blocks = await call<Array<{ title: string; start: number; end: number; for: string }>>("study/plan", { days: typeof input.days === "number" ? input.days : undefined });
        if (!blocks.length) return ok("No study blocks planned yet; study_plan_make makes a plan (or the planner in BridgeDeck's Study tab).");
        return ok(blocks.map((b) => `- ${when(b.start)}–${new Date(b.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}: ${b.title}${b.for ? ` (${b.for})` : ""}`).join("\n"));
      } catch (error) { return fail(error); }
    },
    study_search: async (input) => {
      try {
        const hits = await call<Array<{ course: string; book: string; file: string; page: number; kind?: string; t?: number | null; text: string; link: string }>>("study/search", { query: str(input, "query"), course: str(input, "course") || undefined, limit: typeof input.limit === "number" ? input.limit : undefined });
        if (!hits.length) return ok("No pages match. Try other key terms, or check study_courses for books that aren't searchable yet.");
        const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
        return ok(hits.map((h) => h.kind === "lecture" ? `### Lecture ${h.book} [${clock(h.t ?? 0)}] (${h.course}) link=${h.link}\n${h.text}`
          : h.kind === "note" ? `### Note "${h.book}" (${h.course}) id=${h.file}\n${h.text}`
          : `### ${h.book}, p. ${h.page} (${h.course}) link=${h.link}\n${h.text}`).join("\n\n"));
      } catch (error) { return fail(error); }
    },
    study_read: async (input) => {
      try {
        const result = await call<{ course: string; book: string; pages: number; read: Array<{ page: number; text: string; link: string }> }>("study/read", { course: str(input, "course"), book: str(input, "book"), from: input.from, to: input.to });
        return ok(`# ${result.book} (${result.course}, ${result.pages} pages)\n\n${result.read.map((p) => `--- p. ${p.page} link=${p.link} ---\n${p.text || "(no text on this page; it may be a scanned image)"}`).join("\n\n")}`);
      } catch (error) { return fail(error); }
    },
    study_photo: async (input) => {
      try {
        const photo = await call<{ mime: string; data: string; bytes: number }>("study/photo", { course: str(input, "course"), file: str(input, "file") });
        const images = [{ mimeType: photo.mime, data: photo.data }];
        return { content: withReading(`The photo ${str(input, "file")} (${Math.round(photo.bytes / 1024)} KB) is attached for you to look at.`, await visionReading(images)), modelImages: images };
      } catch (error) { return fail(error); }
    },
    study_lecture: async (input) => {
      try {
        if (!str(input, "file")) {
          const list = await call<Array<{ file: string; modified: number; transcribed: boolean; note: string | null }>>("study/lectures", { course: str(input, "course") });
          if (!list.length) return ok("No lectures in that course yet.");
          return ok(list.map((l) => `- ${l.file} (${when(l.modified, true)}${l.transcribed ? "" : ", not transcribed yet"})`).join("\n"));
        }
        const l = await call<{ file: string; note: string | null; transcript: string; lostAt: string[] }>("study/lectures", { course: str(input, "course"), file: str(input, "file") });
        return ok(`# ${l.file}${l.note ? ` (note id=${l.note})` : ""}${l.lostAt.length ? `\nThe user marked being lost at: ${l.lostAt.join(", ")}` : ""}\n\n${l.transcript}`);
      } catch (error) { return fail(error); }
    },
    study_syllabus: async (input) => {
      const exams = (Array.isArray(input.exams) ? input.exams : []).flatMap((e) => {
        const x = e as Record<string, unknown>;
        const t = parseTime(x.when);
        return t ? [{ title: String(x.title ?? "Exam"), start: Math.round(t.dateOnly ? t.ms + 9 * 3_600_000 : t.ms), room: x.room, covers: x.covers }] : [];
      });
      const payload = { weights: input.weights, people: input.people, exams, aiPolicy: input.ai_policy };
      try {
        await call("study/inbox/add", { kind: "syllabus", course: str(input, "course"), payload });
        return ok(`Suggested. It's waiting in the Study tab under "From Mimir", showing what would change, for the user to accept.`);
      } catch (error) { return fail(error); }
    },
    study_suggest: async (input) => {
      const kind = str(input, "kind");
      if (kind !== "deadline" && kind !== "exam") return fail("kind is deadline or exam.");
      const time = parseTime(input.when);
      if (input.when !== undefined && input.when !== "" && !time) return fail("I couldn't read that time; use 2026-10-03T15:00.");
      if (kind === "exam" && !time) return fail("An exam needs its date and time.");
      // A date alone: due at the end of that day; an exam on that day at 9.
      const ms = time ? (time.dateOnly ? time.ms + (kind === "exam" ? 9 : 23.98) * 3_600_000 : time.ms) : null;
      const payload = kind === "exam"
        ? { title: str(input, "title"), start: Math.round(ms!), room: str(input, "room"), covers: str(input, "covers"), allowed: str(input, "allowed") }
        : { title: str(input, "title"), due: ms == null ? null : Math.round(ms) };
      try {
        await call("study/inbox/add", { kind, course: str(input, "course"), payload });
        return ok(`Suggested. It's waiting in the Study tab under "From Mimir" for the user to add${ms ? ` (${when(ms)})` : ""}.`);
      } catch (error) { return fail(error); }
    },
    flashcards_add: async (input) => {
      const cards = Array.isArray(input.cards) ? input.cards.filter((c): c is Record<string, unknown> => !!c && typeof c === "object") : [];
      if (!cards.length) return fail("Give at least one card.");
      try {
        const result = await call<{ pending: number }>("study/flashcards/add", { course: str(input, "course"), cards });
        return ok(`Suggested ${result.pending} card${result.pending === 1 ? "" : "s"}; they're waiting in the Study tab under "From Mimir" for the user to add.`);
      } catch (error) { return fail(error); }
    },
    projects_list: async () => {
      try {
        const { projects } = await call<{ projects: Array<{ name: string; folder: string; files: number; notes: Array<{ id: string; title: string; kind: string }>; board: Array<{ column: string; cards: string[] }> | null; milestones: Array<{ title: string; start: number }> }> }>("projects/list");
        if (!projects.length) return ok("No projects yet; the user makes them in BridgeDeck's Projects tab.");
        return ok(projects.map((p) => [
          `## ${p.name} (${p.files} files in ${p.folder})`,
          ...(p.board ? p.board.map((c) => `- ${c.column}: ${c.cards.length ? c.cards.join("; ") : "(empty)"}`) : ["- No task board yet"]),
          ...p.notes.map((n) => `- ${n.kind === "list" ? "Checklist" : "Note"}: ${n.title} id=${n.id}`),
          ...p.milestones.map((m) => `- Milestone: ${m.title} on ${when(m.start, true)}`)
        ].join("\n")).join("\n\n"));
      } catch (error) { return fail(error); }
    },
    project_task_add: async (input) => {
      let due: number | undefined;
      if (input.due !== undefined && input.due !== "") {
        const parsed = parseTime(input.due);
        if (!parsed) return fail("I couldn't read that due time; use 2026-10-03T15:00.");
        due = parsed.dateOnly ? parsed.ms + 9 * 3_600_000 : parsed.ms;
      }
      try {
        const result = await call<{ markdown: string }>("projects/task/add", { project: str(input, "project"), task: str(input, "task"), column: str(input, "column") || undefined, due });
        return ok(`Added. The board now:\n${result.markdown}`);
      } catch (error) { return fail(error); }
    },
    project_task_move: async (input) => {
      try {
        const result = await call<{ markdown: string }>("projects/task/move", { project: str(input, "project"), task: str(input, "task"), column: str(input, "column") });
        return ok(`Moved. The board now:\n${result.markdown}`);
      } catch (error) { return fail(error); }
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
export const BRIDGEDECK_CORE_TOOLS = ["notes_search", "note_read", "checklist_add", "checklist_tick", "calendar_list", "calendar_add", "study_search", "study_assignments", "daily_brief"];

type Schedule = { term: { start: string; end: string; breaks: Array<{ start: string; end: string; name: string }> } | null; courses: Array<{ course: string; meetings: Array<{ days: number[]; start: string; end: string; room: string; kind: string }>; changes: Array<{ date: string; cancelled?: boolean; room?: string; note?: string }> }> };

/** Each class in the next `days` days, in this computer's time: inside the semester and outside its
 *  breaks, with one-off changes (cancelled, another room). */
export function classDays(data: Schedule, from: Date, days: number): string[] {
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const date = key(day);
    if (data.term && (date < data.term.start || date > data.term.end)) continue;
    const off = data.term?.breaks.find((b) => date >= b.start && date <= b.end);
    if (off) { lines.push(`- ${when(day.getTime(), true)}: no classes (${off.name || "break"})`); continue; }
    const weekday = day.getDay() === 0 ? 7 : day.getDay();
    for (const c of data.courses) {
      const change = c.changes.find((x) => x.date === date);
      for (const m of c.meetings.filter((m) => Array.isArray(m.days) && m.days.includes(weekday)).sort((a, b) => a.start.localeCompare(b.start))) {
        const room = change?.room || m.room;
        lines.push(`- ${when(day.getTime(), true)} ${m.start}–${m.end}: ${c.course}${m.kind ? ` ${m.kind}` : ""}${change?.cancelled ? " — CANCELLED" : room ? ` in ${room}${change?.room ? " (moved)" : ""}` : ""}${change?.note ? ` — ${change.note}` : ""}`);
      }
    }
  }
  return lines;
}
