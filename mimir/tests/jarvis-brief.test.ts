import { describe, expect, it } from "vitest";
import { jarvisBrief } from "../src/main/jarvis/brief.js";

describe("Jarvis brief", () => {
  it("shows the rest of today, what's due in three days and flashcards, from BridgeDeck", async () => {
    const now = new Date(2026, 9, 24, 9, 0).getTime();
    const at = (h: number, m = 0) => new Date(2026, 9, 24, h, m).getTime();
    const event = (title: string, start: number, end: number) => ({ id: title, title, start, end, allDay: false, location: "", notes: "", repeat: null, skip: [], reminder: null });
    const client = {
      call: async <T>(path: string): Promise<T> => ({
        "calendar/events": [event("Breakfast", at(7), at(8)), event("EE 310", at(10), at(11, 15)), event("Studied EE 310", at(12), at(13)), event("Tomorrow thing", at(33), at(34))],
        "study/assignments": [{ course: "EE 310", title: "HW 6", due: at(23, 59), done: false }, { course: "EE 310", title: "Done one", due: at(20), done: true }, { course: "MATH", title: "Far away", due: now + 10 * 86_400_000, done: false }],
        "study/courses": { courses: [{ name: "EE 310", flashcardsDue: 12 }, { name: "MATH", flashcardsDue: 3 }] }
      } as Record<string, unknown>)[path] as T
    };
    const brief = await jarvisBrief(client, "Mimir · m", now);
    expect(brief.events.map((e) => e.title)).toEqual(["EE 310"]);
    expect(brief.due.map((d) => d.title)).toEqual(["HW 6"]);
    expect(brief.flashcards).toBe(15);
    expect(brief.engine).toBe("Mimir · m");
    expect(brief.system.memTotal).toBeGreaterThan(0);
    expect((await jarvisBrief(null, "x", now)).events).toEqual([]);
  });
});
