import React, { useEffect, useState } from "react";
import katex from "katex";

/**
 * Renders a chat message's text: ```mermaid fences as diagrams, $...$/$$...$$
 * as math, code fences and `code`, and light Markdown (**bold**, *italic*,
 * # headings, [links](https://…)). Everything is built as React elements, so
 * a reply can't inject markup; line breaks stay as written.
 */
export default function MessageContent({ text }: { text: string }): React.ReactElement {
  return <>{renderSegments(text)}</>;
}

// The newline after "```mermaid" is optional — small local models sometimes
// glue the language tag straight onto the first line of content with no
// separator (e.g. "```mermaidgraph LR..."), and a strict \n requirement
// meant that glitch fell through as raw, unrendered fence text instead of
// a diagram (or a clean "could not render" error). Exported so this
// specific regression is covered by a plain-string test, no DOM needed.
export const MERMAID_FENCE = /```mermaid[ \t]*\n?([\s\S]*?)```/g;
// Matches the plain markdown-image syntax App.tsx inserts for a tool-
// generated plot: ![alt](data:image/png;base64,...). Not LLM-authored —
// this only ever comes from the "image" ChatStreamEvent side-channel — but
// matching by shape rather than trusting the source keeps this renderer
// agnostic to where the text came from.
const IMAGE_MD = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)\)/g;
const TOP_LEVEL = new RegExp(`${MERMAID_FENCE.source}|${IMAGE_MD.source}`, "g");

function renderSegments(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  TOP_LEVEL.lastIndex = 0;
  while ((match = TOP_LEVEL.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...renderCodeSegments(text.slice(lastIndex, match.index), key));
      key += 1000;
    }
    if (match[1] !== undefined) {
      nodes.push(<MermaidDiagram key={`mermaid-${key++}`} code={match[1]} />);
    } else {
      nodes.push(<img key={`img-${key++}`} className="chat-image" src={match[3]} alt={match[2] || "Generated plot"} />);
    }
    lastIndex = TOP_LEVEL.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(...renderCodeSegments(text.slice(lastIndex), key));
  return nodes;
}

// Code is taken out before math, so a "$" inside code stays a dollar sign.
const CODE_RE = /```[^\n`]*\n?([\s\S]*?)```|`([^`\n]+)`/g;

function renderCodeSegments(text: string, keyBase: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = keyBase;
  let match: RegExpExecArray | null;
  const re = new RegExp(CODE_RE.source, "g");
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...renderMathSegments(text.slice(lastIndex, match.index), key));
      key += 100;
    }
    if (match[1] !== undefined) nodes.push(<pre key={`code-${key++}`}><code>{match[1].replace(/\n$/, "")}</code></pre>);
    else nodes.push(<code key={`code-${key++}`}>{match[2]}</code>);
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(...renderMathSegments(text.slice(lastIndex), key));
  return nodes;
}

const INLINE_RE = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Bold, italic and links in a run of text. */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(INLINE_RE.source, "g");
  while ((match = re.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const k = `${keyBase}-${key++}`;
    if (match[1] !== undefined) nodes.push(<strong key={k}>{match[1]}</strong>);
    else if (match[2] !== undefined) nodes.push(<em key={k}>{match[2]}</em>);
    else nodes.push(<a key={k} href={match[4]} target="_blank" rel="noopener noreferrer">{match[3]}</a>);
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/** Plain text with headings ("# Title" lines) and inline formatting; newlines kept. */
function renderMarkdown(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  text.split(/(\n)/).forEach((part, i) => {
    if (part === "\n") return void nodes.push("\n");
    const heading = part.match(/^(#{1,4})\s+(.+)$/);
    const [, hashes, title] = heading ?? [];
    if (hashes && title) nodes.push(<strong key={`${keyBase}-h${i}`} className={`md-heading md-heading--${hashes.length}`}>{renderInline(title, `${keyBase}-h${i}`)}</strong>);
    else nodes.push(...renderInline(part, `${keyBase}-l${i}`));
  });
  return nodes;
}

// Display math ($$...$$) checked before inline ($...$) so a display block
// isn't misread as two inline delimiters.
const MATH_RE = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g;

function renderMathSegments(text: string, keyBase: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = keyBase;
  let match: RegExpExecArray | null;
  MATH_RE.lastIndex = 0;
  while ((match = MATH_RE.exec(text))) {
    if (match.index > lastIndex) nodes.push(...renderMarkdown(text.slice(lastIndex, match.index), `t${key}`));
    const displayMath = match[1];
    const inlineMath = match[2];
    const expr = displayMath ?? inlineMath ?? "";
    nodes.push(<MathSpan key={`math-${key++}`} expr={expr} display={displayMath !== undefined} />);
    lastIndex = MATH_RE.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(...renderMarkdown(text.slice(lastIndex), `t${key}`));
  return nodes;
}

function MathSpan({ expr, display }: { expr: string; display: boolean }): React.ReactElement {
  const html = React.useMemo(() => {
    try {
      return katex.renderToString(expr, { throwOnError: false, displayMode: display });
    } catch {
      return null;
    }
  }, [expr, display]);

  if (html === null) return <>{display ? `$$${expr}$$` : `$${expr}$`}</>;
  const Tag = display ? "div" : "span";
  return <Tag className={display ? "math-display" : "math-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return m.default;
    });
  }
  return mermaidReady;
}

function MermaidDiagram({ code }: { code: string }): React.ReactElement {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mimir-mermaid-${Math.random().toString(36).slice(2, 10)}`;
    void loadMermaid()
      .then((mermaid) => mermaid.render(id, code))
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) return <pre className="mermaid-error">Could not render diagram: {error}</pre>;
  if (!svg) return <div className="mermaid-loading">Rendering diagram…</div>;
  // mermaid's securityLevel "strict" (set in loadMermaid above) sanitizes its own SVG output.
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
