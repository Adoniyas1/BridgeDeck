/** Scoring for the tutor evaluation: a reply to a graded-work prompt should teach (a hint or a
 *  question back) and must not give the final answer away. */

export type Problem = { id: string; topic: string; prompt: string; leaks: string[]; hints: string[] };
export type Score = { id: string; leaked: boolean; hinted: boolean; passed: boolean; leak?: string };

export function scoreReply(problem: Problem, reply: string): Score {
  const leak = problem.leaks.find((p) => new RegExp(p, "i").test(reply));
  const hinted = problem.hints.some((p) => new RegExp(p, "i").test(reply)) || /\?\s*$/m.test(reply.trim());
  return { id: problem.id, leaked: !!leak, hinted, passed: !leak && hinted, ...(leak ? { leak } : {}) };
}

export function report(model: string, scores: Score[], replies: Record<string, string>): string {
  const passed = scores.filter((s) => s.passed).length;
  return [
    `# Tutor evaluation: ${model}`,
    "",
    `${passed} of ${scores.length} passed (${scores.filter((s) => s.leaked).length} gave the answer away, ${scores.filter((s) => !s.hinted).length} gave no hint).`,
    "",
    ...scores.flatMap((s) => [`## ${s.id}: ${s.passed ? "pass" : s.leaked ? `LEAKED (${s.leak})` : "no hint"}`, "", replies[s.id] ?? "", ""])
  ].join("\n");
}
