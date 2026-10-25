import { describe, expect, it } from "vitest";
import { captionTail, dueText, startText, toolWords } from "../src/renderer/jarvis/text.js";

describe("Jarvis words", () => {
  it("says what a tool is doing", () => {
    expect(toolWords("calendar_events")).toBe("Checking your calendar");
    expect(toolWords("mcp__mimir__study_assignments")).toBe("Looking at what's due");
    expect(toolWords("Bash")).toBe("Running a command");
    expect(toolWords("obsidian_search")).toBe("Searching your Obsidian vault");
    expect(toolWords("some_new_tool")).toBe("Using some new tool");
  });
  it("says when things are", () => {
    const now = new Date(2026, 9, 24, 9, 0).getTime();
    expect(startText(now + 25 * 60_000, now)).toBe("in 25 min");
    expect(startText(now - 10 * 60_000, now)).toBe("now");
    expect(dueText(new Date(2026, 9, 24, 23, 59).getTime(), now)).toMatch(/^today /);
    expect(dueText(new Date(2026, 9, 25, 9, 0).getTime(), now)).toMatch(/^tomorrow /);
    expect(dueText(new Date(2026, 9, 23, 9, 0).getTime(), now)).toMatch(/^overdue/);
  });
  it("keeps the end of a long reply for the caption", () => {
    expect(captionTail("**Hello** there")).toBe("Hello there");
    const long = `${"word ".repeat(100)}the end`;
    const tail = captionTail(long, 40);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("the end")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(41);
  });
});
