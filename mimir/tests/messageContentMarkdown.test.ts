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

  it("recovers the sloppy fences small local models write", () => {
    // Doubled opener with the language glued onto the code (seen from llama3.2).
    expect(html('``````pythonprint("hi")\n```')).toBe('<pre><code>print(&quot;hi&quot;)</code></pre>');
    expect(html('```\n```python\nprint("hi")\n```')).toBe('<pre><code>print(&quot;hi&quot;)</code></pre>');
    expect(html('```print("hi")```')).toBe('<pre><code>print(&quot;hi&quot;)</code></pre>');
    expect(html('```python print("hi")```')).toBe('<pre><code>print(&quot;hi&quot;)</code></pre>');
    // No closer: runs to the end instead of leaving stray backticks.
    expect(html("Try:\n```js\nconsole.log(1)")).toBe("Try:\n<pre><code>console.log(1)</code></pre>");
    // An empty fence draws nothing, not an empty box.
    expect(html("```\n```")).toBe("");
  });

  it("keeps two fences in a row apart", () => {
    expect(html("```js\na\n```\n```py\nb\n```")).toBe("<pre><code>a</code></pre>\n<pre><code>b</code></pre>");
  });

  it("does not set code or money as math", () => {
    expect(html('$print("hi")$')).toBe('$print(&quot;hi&quot;)$');
    expect(html("It costs $5 and $10.")).toBe("It costs $5 and $10.");
    expect(html("$x^2$")).toContain("katex");
    expect(html("$\\sin(x)$")).toContain("katex");
  });
});
