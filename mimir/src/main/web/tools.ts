import { lookup } from "node:dns/promises";
import net from "node:net";
import type { ToolDef, ToolResult, Toolset } from "../brain/Provider.js";

/**
 * Mimir's web reader: search the web and read ordinary pages, as text, for
 * research. It works with every brain (Anthropic's own web search is extra).
 * Only public http(s) sites: addresses on this computer or the local network
 * are refused, every redirect is checked again, and answers are size-capped.
 * Pages that need JavaScript to show their text won't read well.
 */
const MAX_BYTES = 2_000_000;
const MAX_TEXT = 20_000;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; Mimir/1.0; personal research assistant)";

export type Fetcher = typeof fetch;
export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}

/** A URL Mimir may open: http(s) on a public address. */
export async function checkUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("That isn't a web address."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https pages can be read.");
  if (url.username || url.password) throw new Error("Addresses with passwords in them aren't opened.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Pages on this computer or the local network aren't opened.");
  const addresses = net.isIP(host) ? [host] : await resolve(host).catch(() => { throw new Error(`Couldn't find ${host}.`); });
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error("Pages on this computer or the local network aren't opened.");
  return url;
}

/** Fetches a public page, following up to 5 redirects (each checked), with size and time limits. */
export async function fetchPublic(raw: string, opts: { fetcher?: Fetcher; resolve?: Resolver; init?: RequestInit } = {}): Promise<{ url: string; type: string; body: string }> {
  const fetcher = opts.fetcher ?? fetch;
  let url = await checkUrl(raw, opts.resolve);
  let init: RequestInit = opts.init ?? {};
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5", ...(init.headers ?? {}) } });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = await checkUrl(new URL(response.headers.get("location")!, url).toString(), opts.resolve);
      init = { method: "GET" };
      continue;
    }
    if (!response.ok) throw new Error(`The site answered ${response.status}.`);
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!/text\/|json|xml/.test(type)) throw new Error(`That's a ${type.split(";")[0] || "file"}, not a page Mimir can read.`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); break; }
      chunks.push(value);
    }
    return { url: url.toString(), type, body: new TextDecoder().decode(Buffer.concat(chunks)) };
  }
  throw new Error("Too many redirects.");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** A page's readable text (headings, paragraphs, lists) and its links, without scripts, styles or menus. */
export function htmlToText(html: string, base: string): { title: string; text: string; links: Array<{ text: string; url: string }> } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const main = body.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i);
  if (main && main[2]!.length > 500) body = main[2]!;
  body = body.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ");
  const links: Array<{ text: string; url: string }> = [];
  body = body.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    try {
      const url = new URL(decodeEntities(href), base);
      if ((url.protocol === "http:" || url.protocol === "https:") && text && links.length < 40 && !links.some((l) => l.url === url.toString())) links.push({ text, url: url.toString() });
    } catch { /* not a link to keep */ }
    return text;
  });
  const text = decodeEntities(body
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|h[1-6]|tr|table|blockquote|pre|ul|ol)>/gi, "\n")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, links };
}

/** Results from DuckDuckGo's HTML page: title, address (its redirect undone) and snippet. */
export function parseSearchResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ?? block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    let url = decodeEntities(link[1]!);
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]!);
    if (url.startsWith("//")) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i)?.[1] ?? "";
    const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    results.push({ title: clean(link[2]!), url, snippet: clean(snippet) });
  }
  return results;
}

const ok = (content: string): ToolResult => ({ content });
const fail = (error: unknown): ToolResult => ({ content: error instanceof Error ? error.message : String(error), isError: true });

export function buildWebToolset(opts: { fetcher?: Fetcher; resolve?: Resolver } = {}): Toolset {
  const defs: ToolDef[] = [
    { name: "web_lookup", description: "Search the web (DuckDuckGo) for research: returns titles, addresses and snippets. Then web_read the most useful pages and say which sites your answer comes from.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "web_read", description: "Read a public web page as text (headings, paragraphs, lists) with its main links. Use page=2, 3… to continue a long page.", inputSchema: { type: "object", properties: { url: { type: "string" }, page: { type: "number" } }, required: ["url"] } }
  ];
  const handlers: Toolset["handlers"] = {
    web_lookup: async (input) => {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) return fail("Give something to search for.");
      try {
        const { body } = await fetchPublic("https://html.duckduckgo.com/html/", { ...opts, init: { method: "POST", body: new URLSearchParams({ q: query }).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } } });
        const results = parseSearchResults(body).slice(0, 8);
        if (!results.length) return ok("No results (the search page may have changed or asked for a check). Try web_read on a site you know.");
        return ok(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n"));
      } catch (error) { return fail(error); }
    },
    web_read: async (input) => {
      const page = typeof input.page === "number" && input.page > 1 ? Math.floor(input.page) : 1;
      try {
        const fetched = await fetchPublic(typeof input.url === "string" ? input.url.trim() : "", opts);
        const { title, text, links } = fetched.type.includes("html") ? htmlToText(fetched.body, fetched.url) : { title: "", text: fetched.body, links: [] };
        const pages = Math.max(1, Math.ceil(text.length / MAX_TEXT));
        if (page > pages) return fail(`The page has ${pages} part${pages === 1 ? "" : "s"}.`);
        const part = text.slice((page - 1) * MAX_TEXT, page * MAX_TEXT);
        const head = `# ${title || fetched.url}\n${fetched.url}${pages > 1 ? ` (part ${page} of ${pages})` : ""}\n\n`;
        const tail = page === pages && links.length ? `\n\n---\nLinks:\n${links.slice(0, 25).map((l) => `- ${l.text}: ${l.url}`).join("\n")}` : "";
        return ok(head + (part || "(no readable text; the page may need JavaScript)") + tail);
      } catch (error) { return fail(error); }
    }
  };
  return { defs, handlers };
}
