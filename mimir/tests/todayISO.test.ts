import { describe, expect, it } from "vitest";
import { todayISO } from "../src/main/persona/paths.js";

describe("todayISO", () => {
  it("is this computer's date, not UTC's", () => {
    const evening = new Date(2026, 9, 24, 23, 30);
    expect(todayISO(evening)).toBe("2026-10-24");
    expect(todayISO(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });
});
