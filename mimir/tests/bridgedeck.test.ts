import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bridgeDeckFromEnv, type BridgeDeckClient } from "../src/main/bridgedeck/client.js";
import { buildBridgeDeckToolset, classDays, parseTime } from "../src/main/bridgedeck/tools.js";
import { MEMORY_NOTE_ID, syncMemory } from "../src/main/bridgedeck/memory.js";
import { defaultProjectsRoot } from "../src/main/projects/paths.js";

/** A stand-in for BridgeDeck's /mimir/ API, recording calls. */
function fakeBridgeDeck() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const notes = new Map<string, string>();
  const events: Array<Record<string, unknown>> = [];
  const client: BridgeDeckClient = {
    async call<T>(p: string, body: Record<string, unknown> = {}): Promise<T> {
      calls.push([p, body]);
      switch (p) {
        case "notes/read": {
          const md = notes.get(String(body.id));
          if (md === undefined) throw new Error("No such note");
          return { title: "t", folder: "", markdown: md } as T;
        }
        case "notes/create": notes.set(String(body.id ?? "n1"), String(body.markdown)); return { id: body.id ?? "n1" } as T;
        // BridgeDeck normalises Markdown (blank lines go); the fake does the same.
        case "notes/replace": { const md = String(body.markdown).replace(/\n\n+/g, "\n"); notes.set(String(body.id), md); return { markdown: md } as T; }
        case "notes/append": return {} as T;
        case "calendar/add": events.push({ ...body, id: `e${events.length + 1}` }); return { id: `e${events.length}` } as T;
        case "calendar/events": return events as T;
        case "study/search": return [{ course: "Math 221", book: "Calculus", page: 2, text: "The chain rule…", link: "book:Math%20221/calc.pdf#2" }] as T;
        case "study/read": return { course: "Math 221", book: "Calculus", pages: 3, read: [{ page: 3, text: "", link: "book:Math%20221/calc.pdf#3" }] } as T;
        case "notes/due": return [{ note: "Todo", text: "Pay rent", due: Date.now() - 3_600_000 }, { note: "Todo", text: "Next month", due: Date.now() + 40 * 86_400_000 }] as T;
        case "study/courses": return { courses: [{ name: "Math 221", flashcardsDue: 4 }] } as T;
        case "projects/list": return { projects: [] } as T;
        case "projects/task/add": return { markdown: `## To do\n\n- [ ] ${String(body.task)}` } as T;
        case "study/flashcards/add": return { pending: (body.cards as unknown[]).length } as T;
        case "study/inbox/add": return { id: "x", pending: true } as T;
        default: return null as T;
      }
    }
  };
  return { client, calls, notes };
}

describe("BridgeDeck tools", () => {
  it("only exist when BridgeDeck started Mimir with a loopback address and token", () => {
    expect(bridgeDeckFromEnv({})).toBeNull();
    expect(bridgeDeckFromEnv({ BRIDGEDECK_API: "http://evil.example:1", BRIDGEDECK_TOKEN: "t" })).toBeNull();
    expect(bridgeDeckFromEnv({ BRIDGEDECK_API: "http://127.0.0.1:41416", BRIDGEDECK_TOKEN: "t" })).not.toBeNull();
  });

  it("reads dates as this computer's time", () => {
    expect(parseTime("2026-10-03")).toEqual({ ms: new Date(2026, 9, 3).getTime(), dateOnly: true });
    expect(parseTime("2026-10-03T15:00")?.ms).toBe(new Date(2026, 9, 3, 15).getTime());
    expect(parseTime("soon")).toBeNull();
  });

  it("adds checklist items with due times and calendar events that repeat", async () => {
    const { client, calls } = fakeBridgeDeck();
    const tools = buildBridgeDeckToolset(client);
    await tools.handlers.checklist_add!({ id: "n1", item: "Submit essay", due: "2026-10-03T15:00" });
    const due = new Date(2026, 9, 3, 15).toISOString().slice(0, 16);
    expect(calls.at(-1)).toEqual(["notes/append", { id: "n1", markdown: `- [ ] Submit essay (due ${due}Z)` }]);
    expect((await tools.handlers.checklist_add!({ id: "n1", item: "x", due: "whenever" })).isError).toBe(true);

    const added = await tools.handlers.calendar_add!({ title: "Gym", start: "2026-10-05T07:00", repeat: "weekly" });
    expect(added.content).toContain("Gym");
    const event = calls.find(([p]) => p === "calendar/add")![1];
    expect(event).toMatchObject({ start: new Date(2026, 9, 5, 7).getTime(), end: new Date(2026, 9, 5, 8).getTime(), allDay: false, reminder: 10 });
    const listed = await tools.handlers.calendar_list!({ from: "2026-10-01", to: "2026-10-20" });
    expect(listed.content.match(/Gym/g)).toHaveLength(3); // Oct 5, 12 and 19
    expect((await tools.handlers.calendar_add!({ title: "Bad", start: "2026-10-05T09:00", end: "2026-10-05T08:00" })).isError).toBe(true);
  });
});

describe("study tools", () => {
  it("search with page links, read pages and add flashcards", async () => {
    const { client, calls } = fakeBridgeDeck();
    const tools = buildBridgeDeckToolset(client);
    const found = await tools.handlers.study_search!({ query: "chain rule", course: "math" });
    expect(found.content).toContain("### Calculus, p. 2 (Math 221) link=book:Math%20221/calc.pdf#2");
    expect(calls.at(-1)).toEqual(["study/search", { query: "chain rule", course: "math", limit: undefined }]);
    const read = await tools.handlers.study_read!({ course: "Math 221", book: "Calculus", from: 3 });
    expect(read.content).toContain("--- p. 3 link=book:Math%20221/calc.pdf#3 ---\n(no text on this page");
    expect((await tools.handlers.flashcards_add!({ course: "Math 221", cards: [] })).isError).toBe(true);
    const added = await tools.handlers.flashcards_add!({ course: "Math 221", cards: [{ front: "Chain rule?", back: "f'(g(x))g'(x)", book: "Calculus", page: 2 }] });
    expect(added.content).toBe("Suggested 1 card; they're waiting in the Study tab under \"From Mimir\" for the user to add.");
    const exam = await tools.handlers.study_suggest!({ kind: "exam", course: "Math 221", title: "Midterm", when: "2026-10-30" });
    expect(exam.content).toContain("waiting in the Study tab");
    expect(calls.find(([path]) => path === "study/inbox/add")?.[1]).toMatchObject({ kind: "exam", payload: { title: "Midterm", start: new Date(2026, 9, 30, 9).getTime() } });
    expect((await tools.handlers.study_suggest!({ kind: "exam", course: "x", title: "y" })).content).toContain("needs its date");
  });
});

describe("daily brief", () => {
  it("puts today, what's due, exams coming up and cards to review together", async () => {
    const { client } = fakeBridgeDeck();
    const tools = buildBridgeDeckToolset(client);
    const start = new Date(); start.setHours(0, 0, 0, 0);
    await tools.handlers.calendar_add!({ title: "Math 221: Midterm", start: new Date(start.getTime() + 2 * 86_400_000 + 9 * 3_600_000).toISOString() });
    await tools.handlers.calendar_add!({ title: "Studied Math 221", start: new Date(start.getTime() + 7 * 3_600_000).toISOString() });
    const brief = (await tools.handlers.daily_brief!({})).content;
    expect(brief).toContain("Today: nothing in the calendar.");
    expect(brief).toMatch(/Due:\n- Pay rent \(Todo\) OVERDUE since/);
    expect(brief).not.toContain("Next month");
    expect(brief).toMatch(/Coming up:\n- .*: Math 221: Midterm/);
    expect(brief).toContain("Flashcards to review: Math 221 4");
  });
});

describe("project tools", () => {
  it("add tasks with due times and follow Mimir's projects folder", async () => {
    const { client, calls } = fakeBridgeDeck();
    const tools = buildBridgeDeckToolset(client);
    const added = await tools.handlers.project_task_add!({ project: "Robot", task: "Order motors", due: "2026-10-03T15:00" });
    expect(added.content).toBe("Added. The board now:\n## To do\n\n- [ ] Order motors");
    expect(calls.at(-1)![1]).toMatchObject({ project: "Robot", task: "Order motors", due: new Date(2026, 9, 3, 15).getTime() });
    expect((await tools.handlers.project_task_add!({ project: "Robot", task: "x", due: "soon" })).isError).toBe(true);
    expect(defaultProjectsRoot({ MIMIR_PROJECTS_ROOT: "/Users/me/BridgeDeck Shared/Projects" })).toBe("/Users/me/BridgeDeck Shared/Projects");
    expect(defaultProjectsRoot({ MIMIR_PROJECTS_ROOT: "relative" })).toBe(path.join(os.homedir(), "Documents", "Mimir Projects"));
  });
});

describe("memory sync", () => {
  it("creates the note, pushes Mimir's changes, and takes the user's edits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-memory-"));
    const { client, notes } = fakeBridgeDeck();
    let file = "# Memory\n\n- Likes tea";
    const opts = { client, readMemory: async () => file, writeMemory: async (md: string) => { file = md; }, statePath: path.join(dir, "state.json") };
    expect(await syncMemory(opts)).toBe("created");
    expect(notes.get(MEMORY_NOTE_ID)).toBe(file);
    expect(await syncMemory(opts)).toBe("same");
    file = "# Memory\n\n- Likes tea\n- Works on BridgeDeck";
    expect(await syncMemory(opts)).toBe("pushed");
    // BridgeDeck stored it slightly differently; that isn't a change by the user.
    expect(await syncMemory(opts)).toBe("same");
    notes.set(MEMORY_NOTE_ID, "# Memory\n- Likes coffee now");
    expect(await syncMemory(opts)).toBe("pulled");
    expect(file).toBe("# Memory\n- Likes coffee now");
    expect(await syncMemory(opts)).toBe("same");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("class days for Mimir", () => {
  it("lists classes in the semester, skips breaks and shows changes", () => {
    const data = {
      term: { start: "2026-10-01", end: "2026-12-15", breaks: [{ start: "2026-10-23", end: "2026-10-23", name: "Fall recess" }] },
      courses: [{ course: "EE 310", meetings: [{ days: [4, 5], start: "10:00", end: "11:15", room: "ECS 302", kind: "" }], changes: [{ date: "2026-10-29", room: "VEC 115" }, { date: "2026-10-30", cancelled: true }] }]
    };
    // Thursday 22 Oct to Friday 30 Oct.
    const lines = classDays(data, new Date(2026, 9, 22), 9);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/Oct 22, 2026 10:00–11:15: EE 310 in ECS 302$/);
    expect(lines[1]).toMatch(/no classes \(Fall recess\)/);
    expect(lines[2]).toMatch(/in VEC 115 \(moved\)$/);
    expect(lines[3]).toMatch(/CANCELLED$/);
  });
});
