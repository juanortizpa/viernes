import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { Tool } from "./types";

/**
 * Web tools (ADR-0028). Both are `read` (nothing changes on the machine) but they SEND data out, so they declare where to
 * (`egressTo`): once a task has read untrusted content, the policy engine only lets a page be fetched without asking if its exact
 * URL came from a previous result or from the user — an injected page cannot make the assistant carry data to a new address.
 * Everything they return is `untrusted_external`.
 */
export type FetchFn = (url: string, init: { headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<Response>;
export type LookupFn = (host: string) => Promise<string[]>;

export interface WebOptions {
  fetch?: FetchFn;
  lookup?: LookupFn;
  timeoutMs?: number;
  /** Bytes read from a response at most. */
  maxBytes?: number;
  /** Characters of page text handed to the model at most. */
  maxChars?: number;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JARVIS/0.1 (asistente personal)";
const defaultLookup: LookupFn = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Loopback, private, link-local, CGNAT, multicast and unspecified addresses: the web tools never reach the local network. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return true; // not an address at all: refuse
}

/** Throws unless `raw` is an http(s) URL whose host resolves only to public addresses. */
export async function assertPublicUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`no es una URL válida: ${raw.slice(0, 100)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`solo http y https (no ${url.protocol})`);
  if (url.username || url.password) throw new Error("no sigo URLs con usuario o contraseña");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new Error("no accedo a la red local");
  const addrs = isIP(host) ? [host] : await lookup(host).catch(() => {
    throw new Error(`no encuentro el sitio ${host}`);
  });
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error("no accedo a la red local");
  return url;
}

/** Canonical form used to compare URLs (fragment dropped, host lowercased by URL). */
export function normalizeUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Every http(s) URL inside a piece of text (tool output, user message). */
export function extractUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\)\]]+/g)) {
    const n = normalizeUrl(m[0].replace(/[.,;:!?]+$/, ""));
    if (n) out.add(n);
  }
  return [...out];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable text of an HTML page, its title, and its links (absolute), without scripts, styles or markup. */
export function htmlToText(html: string, base?: string): { title: string; text: string; links: { text: string; url: string }[] } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ");
  const links: { text: string; url: string }[] = [];
  for (const m of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decodeEntities(m[2]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    let url: string | undefined;
    try {
      url = normalizeUrl(new URL(decodeEntities(m[1]!), base).toString());
    } catch {
      url = undefined;
    }
    if (text && url && /^https?:/.test(url) && links.length < 200) links.push({ text: text.slice(0, 80), url });
  }
  body = body
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { title, text, links };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) bytes.set(c, o), (o += c.length);
  return { bytes, truncated };
}

/** GET with the public-address check applied to the URL AND to every redirect hop. */
async function safeGet(raw: string, o: Required<Pick<WebOptions, "fetch" | "lookup" | "timeoutMs" | "maxBytes">>, signal?: AbortSignal): Promise<{ url: string; status: number; type: string; body: string; truncated: boolean }> {
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = (await assertPublicUrl(raw, o.lookup)).toString();
  for (let hop = 0; hop <= 5; hop++) {
    const res = await o.fetch(url, { headers: { "user-agent": UA, "accept-language": "es,en;q=0.7", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" }, redirect: "manual", signal: sig });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = (await assertPublicUrl(new URL(res.headers.get("location")!, url).toString(), o.lookup)).toString();
      continue;
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !/^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json))/.test(type)) {
      await res.body?.cancel().catch(() => {});
      return { url, status: res.status, type, body: "", truncated: false };
    }
    const { bytes, truncated } = await readCapped(res, o.maxBytes);
    const charset = /charset=([\w-]+)/.exec(type)?.[1] ?? "utf-8";
    let body: string;
    try {
      body = new TextDecoder(charset).decode(bytes);
    } catch {
      body = new TextDecoder("utf-8").decode(bytes);
    }
    return { url, status: res.status, type, body, truncated };
  }
  throw new Error("demasiadas redirecciones");
}

const withDefaults = (o: WebOptions) => ({
  fetch: o.fetch ?? ((url, init) => fetch(url, init)),
  lookup: o.lookup ?? defaultLookup,
  timeoutMs: o.timeoutMs ?? 15_000,
  maxBytes: o.maxBytes ?? 2_000_000,
  maxChars: o.maxChars ?? 6_000, // two pages must fit the free tiers' tokens-per-minute limits (measured: 2 x 12k chars got "Request too large" from Groq)
});

export interface WebPage {
  url: string;
  title: string;
  text: string;
  links: { text: string; url: string }[];
  truncated: boolean;
}

export function makeWebFetch(opts: WebOptions = {}): Tool<{ url: string }, WebPage> {
  const o = withDefaults(opts);
  return {
    name: "web.fetch",
    description: "Read a public web page (http/https) and return its title, readable text and links. Use it to check current facts from a source.",
    risk: "read",
    reversible: true,
    input: z.object({ url: z.string().min(8).max(2000) }),
    egressTo: ({ url }) => url,
    async run({ url }, ctx) {
      try {
        const r = await safeGet(url, o, ctx.signal);
        if (r.status >= 400) return { ok: false, summary: `${new URL(r.url).hostname} respondió ${r.status}`, provenance: "system" };
        if (!r.body) return { ok: false, summary: `no leo ese tipo de contenido (${r.type || "desconocido"})`, provenance: "system" };
        const isHtml = /html|xml/.test(r.type) || /^\s*</.test(r.body);
        const page = isHtml ? htmlToText(r.body, r.url) : { title: "", text: r.body, links: [] };
        const cut = page.text.length > o.maxChars;
        const out: WebPage = { url: r.url, title: page.title, text: cut ? page.text.slice(0, o.maxChars) + "…" : page.text, links: page.links.slice(0, 15), truncated: cut || r.truncated };
        return { ok: true, summary: `leí ${new URL(r.url).hostname}${page.title ? `: ${page.title.slice(0, 80)}` : ""}`, output: out, provenance: "untrusted_external" };
      } catch (e) {
        return { ok: false, summary: `no pude leer la página: ${e instanceof Error ? e.message : String(e)}`, provenance: "system" };
      }
    },
  };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Results of DuckDuckGo's HTML endpoint (no key, no account). Unofficial: if its markup changes this returns nothing, never junk. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const b of blocks) {
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    let href = decodeEntities(a[1]!);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]!);
    if (href.startsWith("//")) href = `https:${href}`;
    const url = normalizeUrl(href);
    if (!url || !/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/.exec(b)?.[1] ?? "";
    const clean = (s: string): string => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    out.push({ title: clean(a[2]!), url, snippet: clean(snippet).slice(0, 300) });
  }
  return out;
}

export function makeWebSearch(opts: WebOptions & { maxResults?: number } = {}): Tool<{ query: string }, SearchResult[]> {
  const o = withDefaults(opts);
  return {
    name: "web.search",
    description: "Search the web (DuckDuckGo) for current information: news, prices, schedules, recent events, documentation. Returns titles, URLs and snippets; read a result with web.fetch when the snippet is not enough.",
    risk: "read",
    reversible: true,
    input: z.object({ query: z.string().min(2).max(300) }),
    // No `egressTo`: the query only ever goes to the search engine, an address no injected text can choose or read back.
    async run({ query }, ctx) {
      try {
        const r = await safeGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=es-es`, o, ctx.signal);
        if (r.status >= 400) return { ok: false, summary: `el buscador respondió ${r.status}`, provenance: "system" };
        const results = parseDuckDuckGo(r.body).slice(0, opts.maxResults ?? 8);
        if (results.length === 0) return { ok: false, summary: /anomaly|captcha/i.test(r.body) ? "el buscador pidió verificación humana; probá más tarde" : "sin resultados", provenance: "system" };
        return { ok: true, summary: `${results.length} resultado(s) para «${query.slice(0, 60)}»`, output: results, provenance: "untrusted_external" };
      } catch (e) {
        return { ok: false, summary: `no pude buscar: ${e instanceof Error ? e.message : String(e)}`, provenance: "system" };
      }
    },
  };
}
