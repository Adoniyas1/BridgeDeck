import { describe, it, expect } from "vitest";
import { lightMarkdownBlocks, renderTextToPdf } from "../src/main/projects/pdf.js";

describe("PDF export", () => {
  it("splits light markdown into headings, paragraphs and code", () => {
    const blocks = lightMarkdownBlocks("# Title\nfirst line\nsecond line\n\n```\nx = 1\n```\n## Next");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "first line second line" },
      { kind: "code", text: "x = 1" },
      { kind: "heading", level: 2, text: "Next" }
    ]);
  });

  it("renders a real PDF without a browser", async () => {
    const pdf = await renderTextToPdf("Report", "# Results\nAll good.\n```\nprint(1)\n```");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(500);
  });
});
