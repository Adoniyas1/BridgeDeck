import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bridgeDeckFromEnv, type BridgeDeckClient } from "../src/main/bridgedeck/client.js";
import { buildBridgeDeckToolset, parseTime } from "../src/main/bridgedeck/tools.js";
import { MEMORY_NOTE_ID, syncMemory } from "../src/main/bridgedeck/memory.js";

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
