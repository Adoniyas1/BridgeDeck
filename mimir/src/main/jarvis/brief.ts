import os from "node:os";
import type { BridgeDeckClient } from "../bridgedeck/client.js";
import { occurrences, type CalEvent } from "../bridgedeck/recur.js";
import type { JarvisBrief } from "../../shared/types.js";

/** CPU busy share since the last call (0-1), from the per-core time counters (os.loadavg is 0 on
 * Windows). */
let last: { idle: number; total: number } | null = null;
export function cpuLoad(): number {
  const cpus = os.cpus();
  const idle = cpus.reduce((s, c) => s + c.times.idle, 0);
  const total = cpus.reduce((s, c) => s + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0);
  const prev = last;
  last = { idle, total };
  if (!prev || total <= prev.total) return 0;
  return Math.max(0, Math.min(1, 1 - (idle - prev.idle) / (total - prev.total)));
}

/** What the Jarvis view shows beside the orb: the rest of today, what's due soon, flashcards to
 * review, and how hard this computer is working. Parts BridgeDeck can't give are left empty. */
export async function jarvisBrief(client: BridgeDeckClient | null, engine: string, now = Date.now()): Promise<JarvisBrief> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const tomorrow = startOfDay.getTime() + 86_400_000;
  const brief: JarvisBrief = {
    events: [],
    due: [],
    flashcards: 0,
    system: { memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(), cpu: cpuLoad() },
    engine
  };
  if (!client) return brief;
  const [events, assignments, study] = await Promise.all([
    client.call<CalEvent[]>("calendar/events").catch(() => [] as CalEvent[]),
    client.call<Array<{ course: string; title: string; due: number | null; done: boolean }>>("study/assignments").catch(() => []),
    client.call<{ courses: Array<{ name: string; flashcardsDue: number }> }>("study/courses").catch(() => ({ courses: [] }))
  ]);
  const studied = new Set(study.courses.map((c) => `Studied ${c.name}`));
  brief.events = events
    .flatMap((e) => occurrences(e, now - 3_600_000, tomorrow).map((o) => ({ title: e.title || "(untitled)", start: o.start, end: o.end, allDay: e.allDay, location: e.location })))
    .filter((e) => !studied.has(e.title) && (e.allDay || e.end > now))
    .sort((a, b) => a.start - b.start)
    .slice(0, 6);
  brief.due = assignments
    .filter((a) => !a.done && a.due !== null && a.due > now - 86_400_000 && a.due < now + 3 * 86_400_000)
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0))
    .slice(0, 6)
    .map((a) => ({ title: a.title, course: a.course, due: a.due ?? 0 }));
  brief.flashcards = study.courses.reduce((s, c) => s + (c.flashcardsDue || 0), 0);
  return brief;
}
