import type { ChatStreamEvent, TeamProgress } from "../shared/types.js";

/** The Brain team's progress on a reply, updated by one stream event. */
export function applyTeamEvent(team: TeamProgress | undefined, event: ChatStreamEvent): TeamProgress | undefined {
  if (event.type === "team-plan") {
    return { steps: event.steps.map((s) => ({ goal: s.goal, status: "waiting", role: null, model: null, tools: [] })) };
  }
  if (!team) return team;
  if (event.type === "team-step") {
    return { steps: team.steps.map((s, i) => (i === event.index ? { ...s, status: event.status, role: event.role, model: event.model, note: event.note } : s)) };
  }
  if (event.type === "tool-start" && event.step != null) {
    return { steps: team.steps.map((s, i) => (i === event.step ? { ...s, tools: [...s.tools, event.name] } : s)) };
  }
  return team;
}

