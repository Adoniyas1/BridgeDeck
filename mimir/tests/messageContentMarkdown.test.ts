import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MessageContent from "../src/renderer/MessageContent.js";

const html = (text: string) => renderToStaticMarkup(React.createElement(MessageContent, { text }));

describe("MessageContent markdown", () => {
  it("renders bold, italic, links and headings as elements", () => {
    expect(html("Start with **K-maps** and *flip-flops*")).toBe("Start with <strong>K-maps</strong> and <em>flip-flops</em>");
    expect(html("See [the datasheet](https://ti.com/7447)")).toBe('See <a href="https://ti.com/7447" target="_blank" rel="noopener noreferrer">the datasheet</a>');
    expect(html("## Plan\n1. one")).toBe('<strong class="md-heading md-heading--2">Plan</strong>\n1. one');
  });

  it("keeps code as code, even with $ or ** inside", () => {
    expect(html("Run `echo $HOME **x**`")).toBe("Run <code>echo $HOME **x**</code>");
    expect(html("```python\nprint(2 ** 10)\n```")).toBe("<pre><code>print(2 ** 10)</code></pre>");
  });

  it("never turns text into markup, and only allows web links", () => {
    expect(html("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(html("[click](javascript:alert(1))")).toBe("[click](javascript:alert(1))");
  });
});
