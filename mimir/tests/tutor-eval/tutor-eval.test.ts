/** The tutor module, checked against a fixed set of EE problems. The scoring is always tested; the
 *  models are only asked when MIMIR_TUTOR_EVAL_URL (an OpenAI-compatible server, e.g. llama-swap)
 *  and MIMIR_TUTOR_EVAL_MODELS (comma-separated) are set, so CI doesn't run it. Reports are written
 *  beside this file as report-<model>.md. */

import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPromptModule } from "../../src/main/prompts/modules.js";
import problems from "./problems.json";
import { report, scoreReply, type Problem } from "./score.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.MIMIR_TUTOR_EVAL_URL ?? "";
const models = (process.env.MIMIR_TUTOR_EVAL_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);

describe("tutor scoring", () => {
  const divider = (problems as Problem[]).find((p) => p.id === "divider")!;
  it("passes a hint and fails an answer", () => {
    expect(scoreReply(divider, "Think of it as a voltage divider: what fraction of the total resistance is R2? What have you tried?").passed).toBe(true);
    expect(scoreReply(divider, "V2 = 12 × 10/14.7 = 8.16 V.")).toMatchObject({ leaked: true, passed: false });
    expect(scoreReply(divider, "Sure.").passed).toBe(false);
  });
  it("has a problem for each area", () => {
    expect(new Set((problems as Problem[]).map((p) => p.topic))).toEqual(new Set(["circuits", "signals", "digital"]));
  });
});

describe.skipIf(!url || !models.length)("tutor evaluation against real models", () => {
  const tutor = getPromptModule("tutor")!;
  for (const model of models) {
    it(`${model} teaches instead of solving`, async () => {
      const replies: Record<string, string> = {};
      const scores = [];
      for (const problem of problems as Problem[]) {
        const res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: tutor.text }, { role: "user", content: problem.prompt }], chat_template_kwargs: { enable_thinking: false } })
        });
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        replies[problem.id] = body.choices?.[0]?.message?.content ?? "";
        scores.push(scoreReply(problem, replies[problem.id]!));
      }
      await writeFile(path.join(here, `report-${model.replace(/[^\w.-]+/g, "_")}.md`), report(model, scores, replies));
      expect(scores.filter((s) => s.leaked).map((s) => s.id)).toEqual([]);
    }, 15 * 60_000);
  }
});
