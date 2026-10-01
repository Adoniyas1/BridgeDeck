import PDFDocument from "pdfkit";

type Block = { kind: "heading"; level: number; text: string } | { kind: "paragraph"; text: string } | { kind: "code"; text: string };

/**
 * Very small, dependency-free markdown-ish parser for export purposes only —
 * not a full renderer, just enough structure (headings, paragraphs, fenced
 * code blocks) that an exported answer or write-up reads better than a wall
 * of plain text. Deliberately not reusing the renderer's MessageContent.tsx:
 * that's a React component tied to the DOM; this runs in the main process.
 */
export function lightMarkdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) {
      flushParagraph();
      if (code) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  if (code) blocks.push({ kind: "code", text: code.join("\n") });
  return blocks;
}

/** Renders `body` (light markdown) to a Letter-size PDF buffer with pdfkit
 * (pure JavaScript, so it runs in plain Node — no browser print pipeline). */
export async function renderTextToPdf(title: string, body: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 48, bottom: 48, left: 56, right: 56 }, info: { Title: title } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.font("Helvetica-Bold").fontSize(22).fillColor("#1a1a1a").text(title);
  const ruleY = doc.y + 4;
  doc.moveTo(doc.page.margins.left, ruleY).lineTo(doc.page.width - doc.page.margins.right, ruleY).strokeColor("#cccccc").stroke();
  doc.moveDown(1);

  const headingSizes = [0, 18, 15, 13, 12];
  for (const block of lightMarkdownBlocks(body)) {
    if (block.kind === "heading") {
      doc.moveDown(0.6).font("Helvetica-Bold").fontSize(headingSizes[block.level] ?? 12).fillColor("#1a1a1a").text(block.text);
      doc.moveDown(0.3);
    } else if (block.kind === "code") {
      doc.font("Courier").fontSize(10).fillColor("#333333").text(block.text, { lineGap: 1 });
      doc.moveDown(0.8);
    } else {
      doc.font("Times-Roman").fontSize(12).fillColor("#1a1a1a").text(block.text, { lineGap: 3 });
      doc.moveDown(0.6);
    }
  }
  doc.end();
  return done;
}
