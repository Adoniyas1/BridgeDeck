import { describe, expect, it } from "vitest";
import { buildWebToolset, checkUrl, decodeEntities, htmlToText, isPrivateAddress, parseSearchResults, type Fetcher } from "../src/main/web/tools.js";

const publicDns = async () => ["93.184.216.34"];
const page = (body: string, init: ResponseInit & { type?: string } = {}) => new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html; charset=utf-8", ...(init.headers as Record<string, string> ?? {}) } });

describe("web reader", () => {
  it("refuses this computer and the local network, also after redirects", async () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "100.64.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(a), a).toBe(false);
    await expect(checkUrl("http://localhost:41416/mimir/notes", publicDns)).rejects.toThrow("local network");
    await expect(checkUrl("http://127.0.0.1:8080/", publicDns)).rejects.toThrow("local network");
    await expect(checkUrl("http://printer.example/", async () => ["192.168.1.9"])).rejects.toThrow("local network");
    await expect(checkUrl("file:///etc/passwd", publicDns)).rejects.toThrow("http");
    await expect(checkUrl("https://user:pw@example.com/", publicDns)).rejects.toThrow("passwords");
    const fetcher: Fetcher = async (url) => String(url).includes("example.com") ? page("", { status: 302, headers: { location: "http://127.0.0.1/admin" } }) : page("secret");
    const result = await buildWebToolset({ fetcher, resolve: publicDns }).handlers.web_read!({ url: "https://example.com/go" });
    expect(result).toEqual({ content: "Pages on this computer or the local network aren't opened.", isError: true });
  });

  it("turns a page into readable text with its links", () => {
    const html = `<html><head><title>Chain rule &mdash; Calculus</title><style>.x{}</style></head><body><nav><a href="/home">Home</a></nav>
      <main><h1>The chain rule</h1><p>If <b>y = f(g(x))</b>, then dy/dx = f'(g(x))&nbsp;g'(x).</p><script>alert(1)</script>
      <ul><li>Step one</li><li>Step <a href="/two">two</a></li></ul><p>${"Filler text. ".repeat(50)}</p></main><footer>© site</footer></body></html>`;
    const { title, text, links } = htmlToText(html, "https://math.example/rules");
    expect(title).toBe("Chain rule — Calculus");
    expect(text.startsWith("# The chain rule\nIf y = f(g(x)), then dy/dx = f'(g(x)) g'(x).\n\n- Step one\n- Step two")).toBe(true);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("Home");
    expect(links).toEqual([{ text: "two", url: "https://math.example/two" }]);
    expect(decodeEntities("&#x2014;&#8212;&amp;&bogus;")).toBe("——&&bogus;");
  });

  it("reads DuckDuckGo results with their real addresses", async () => {
    const html = `<div class="result results_links web-result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FChain_rule&amp;rut=x">Chain <b>rule</b> - Wikipedia</a></h2>
      <a class="result__snippet" href="#">In calculus, the <b>chain rule</b> is a formula…</a></div>
      <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`;
    expect(parseSearchResults(html)).toEqual([{ title: "Chain rule - Wikipedia", url: "https://en.wikipedia.org/wiki/Chain_rule", snippet: "In calculus, the chain rule is a formula…" }]);
    let posted = "";
    const fetcher: Fetcher = async (_url, init) => { posted = String(init?.body); return page(html); };
    const found = await buildWebToolset({ fetcher, resolve: publicDns }).handlers.web_lookup!({ query: "chain rule" });
    expect(posted).toBe("q=chain+rule");
    expect(found.content).toBe("1. Chain rule - Wikipedia\n   https://en.wikipedia.org/wiki/Chain_rule\n   In calculus, the chain rule is a formula…");
  });

  it("splits long pages into parts and refuses files it can't read", async () => {
    const long = `<p>${"word ".repeat(9000)}</p>`;
    const tools = buildWebToolset({ fetcher: async (url) => String(url).endsWith(".pdf") ? page("%PDF", { type: "application/pdf" }) : page(long), resolve: publicDns });
    const first = await tools.handlers.web_read!({ url: "https://example.com/a" });
    expect(first.content).toContain("(part 1 of 3)");
    expect((await tools.handlers.web_read!({ url: "https://example.com/a", page: 3 })).content).toContain("(part 3 of 3)");
    expect((await tools.handlers.web_read!({ url: "https://example.com/a", page: 4 })).isError).toBe(true);
    expect((await tools.handlers.web_read!({ url: "https://example.com/b.pdf" })).content).toContain("application/pdf");
  });
});
