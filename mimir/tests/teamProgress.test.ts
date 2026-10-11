import { describe, expect, it } from "vitest";
import { applyTeamEvent } from "../src/renderer/teamProgress.js";

describe("team progress in the chat", () => {
  it("starts from the plan and follows each step", () => {
    let team = applyTeamEvent(undefined, { type: "team-plan", steps: [{ goal: "Compute" }, { goal: "Save" }] });
    expect(team?.steps.map((s) => s.status)).toEqual(["waiting", "waiting"]);
    team = applyTeamEvent(team, { type: "team-step", index: 0, status: "running", role: "executor", model: "bonsai-8b" });
    team = applyTeamEvent(team, { type: "tool-start", name: "run_python", step: 0 });
    team = applyTeamEvent(team, { type: "team-step", index: 0, status: "retry", role: "executor", model: "bonsai-8b", note: "wrong number" });
    expect(team?.steps[0]).toEqual({ goal: "Compute", status: "retry", role: "executor", model: "bonsai-8b", note: "wrong number", tools: ["run_python"] });
    expect(team?.steps[1]?.status).toBe("waiting");
  });

  it("ignores step events with no plan, and tool events outside a step", () => {
    expect(applyTeamEvent(undefined, { type: "team-step", index: 0, status: "passed", role: "head", model: "q" })).toBeUndefined();
    const team = applyTeamEvent(undefined, { type: "team-plan", steps: [{ goal: "A" }] });
    expect(applyTeamEvent(team, { type: "tool-start", name: "x", step: null })).toBe(team);
  });
});
