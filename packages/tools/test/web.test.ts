import { describe, expect, it } from "vitest";
import { assertPublicUrl, extractUrls, htmlToText, isPrivateAddress, makeWebFetch, makeWebSearch, normalizeUrl, parseDuckDuckGo, type FetchFn } from "../src";

/** Trimmed from a real html.duckduckgo.com response (2026-10-04): the parser is tested against the markup it will meet. */
const DDG = `<html><body>
<div class="result results_links results_links_deep result--ad ">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x&amp;u3=1">Anuncio</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2F&amp;rut=cdbe">Getting Started | Guide | Vitest</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2F&amp;rut=cdbe">Learn how to install, configure and use <b>Vitest</b> &amp; more.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ambito.com%2Fdolar%3Fx%3D1%26y%3D2&amp;rut=ab">Cotización del dólar | Ámbito</a></h2>
  <a class="result__snippet" href="#">Dólar blue hoy</a>
</div>
</body></html>`;

const publicLookup = async () => ["93.184.216.34"];
const res = (body: string, init: { status?: number; type?: string; location?: string } = {}): Response =>
  new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html; charset=utf-8", ...(init.location ? { location: init.location } : {}) } });

describe("web: address safety (no local network, ADR-0028)", () => {
  it("classifies private, loopback, link-local, CGNAT and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1", "nope"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses non-http schemes, credentials, local names and hosts that resolve to private addresses", async () => {
    await expect(assertPublicUrl("file:///C:/Windows/win.ini", publicLookup)).rejects.toThrow(/solo http/);
    await expect(assertPublicUrl("https://user:pw@example.com", publicLookup)).rejects.toThrow(/contraseña/);
    await expect(assertPublicUrl("http://localhost:11434/api", publicLookup)).rejects.toThrow(/red local/);
    await expect(assertPublicUrl("http://[::1]:8080", publicLookup)).rejects.toThrow(/red local/);
    await expect(assertPublicUrl("http://router.example", async () => ["192.168.0.1"])).rejects.toThrow(/red local/);
    await expect(assertPublicUrl("http://mixed.example", async () => ["93.184.216.34", "10.0.0.1"])).rejects.toThrow(/red local/);
    expect((await assertPublicUrl("https://example.com/a", publicLookup)).hostname).toBe("example.com");
  });

  it("a redirect to the local network is refused too", async () => {
    const fetch: FetchFn = async (url) => (url.startsWith("https://evil.example") ? res("", { status: 302, location: "http://127.0.0.1:3000/admin" }) : res("never"));
    const r = await makeWebFetch({ fetch, lookup: async (h) => (h === "127.0.0.1" ? ["127.0.0.1"] : ["93.184.216.34"]) }).run({ url: "https://evil.example/go" }, { taskId: "t" });
    expect(r).toMatchObject({ ok: false, summary: expect.stringMatching(/red local/) });
  });
});

describe("web.fetch", () => {
  it("returns readable text, title and absolute links, marked untrusted; follows public redirects", async () => {
    const html = `<html><head><title>Dólar &amp; más</title><style>.x{}</style><script>alert(1)</script></head>
      <body><nav><a href="/hoy">Hoy</a></nav><h1>Cotización</h1><p>Blue: <b>$1.560</b></p><ul><li>uno</li><li>dos</li></ul>
      <!-- comentario --><a href="https://otro.example/x#frag">Otro</a><noscript>sin js</noscript></body></html>`;
    const seen: string[] = [];
    const fetch: FetchFn = async (url) => (seen.push(url), url === "https://a.example/" ? res("", { status: 301, location: "/final" }) : res(html));
    const r = await makeWebFetch({ fetch, lookup: publicLookup }).run({ url: "https://a.example" }, { taskId: "t" });
    expect(seen).toEqual(["https://a.example/", "https://a.example/final"]);
    expect(r.ok).toBe(true);
    expect(r.provenance).toBe("untrusted_external");
    expect(r.output!.title).toBe("Dólar & más");
    expect(r.output!.text).toContain("Blue: $1.560");
    expect(r.output!.text).toContain("• uno");
    expect(r.output!.text).not.toMatch(/alert|\.x\{|comentario|sin js/);
    expect(r.output!.links).toEqual([
      { text: "Hoy", url: "https://a.example/hoy" },
      { text: "Otro", url: "https://otro.example/x" },
    ]);
  });

  it("caps size, refuses binaries and reports HTTP errors plainly", async () => {
    const big = makeWebFetch({ fetch: async () => res("<p>" + "a".repeat(50_000) + "</p>"), lookup: publicLookup, maxChars: 1000 });
    const r = await big.run({ url: "https://a.example" }, { taskId: "t" });
    expect(r.output!.text.length).toBe(1001);
    expect(r.output!.truncated).toBe(true);
    const bytes = await makeWebFetch({ fetch: async () => res("x".repeat(5000)), lookup: publicLookup, maxBytes: 100 }).run({ url: "https://a.example" }, { taskId: "t" });
    expect(bytes.output!.truncated).toBe(true);
    expect(await makeWebFetch({ fetch: async () => res("PK..", { type: "application/zip" }), lookup: publicLookup }).run({ url: "https://a.example/f.zip" }, { taskId: "t" })).toMatchObject({ ok: false, summary: expect.stringMatching(/no leo ese tipo/) });
    expect(await makeWebFetch({ fetch: async () => res("nope", { status: 404 }), lookup: publicLookup }).run({ url: "https://a.example" }, { taskId: "t" })).toMatchObject({ ok: false, summary: "a.example respondió 404" });
  });

  it("declares where it sends data, so the policy engine can judge it", () => {
    expect(makeWebFetch().egressTo?.({ url: "https://x.example/?q=secret" })).toBe("https://x.example/?q=secret");
    expect(makeWebSearch().egressTo).toBeUndefined(); // the query only ever goes to the search engine
  });
});

describe("web.search (DuckDuckGo HTML)", () => {
  it("parses real result markup: decodes redirect links, skips ads, cleans snippets", () => {
    expect(parseDuckDuckGo(DDG)).toEqual([
      { title: "Getting Started | Guide | Vitest", url: "https://vitest.dev/guide/", snippet: "Learn how to install, configure and use Vitest & more." },
      { title: "Cotización del dólar | Ámbito", url: "https://www.ambito.com/dolar?x=1&y=2", snippet: "Dólar blue hoy" },
    ]);
    expect(parseDuckDuckGo("<html>changed markup</html>")).toEqual([]);
  });

  it("returns results as untrusted data and says when the engine asks for a captcha", async () => {
    const urls: string[] = [];
    const ok = await makeWebSearch({ fetch: async (u) => (urls.push(u), res(DDG)), lookup: publicLookup }).run({ query: "dólar hoy" }, { taskId: "t" });
    expect(urls[0]).toBe("https://html.duckduckgo.com/html/?q=d%C3%B3lar%20hoy&kl=es-es");
    expect(ok).toMatchObject({ ok: true, provenance: "untrusted_external", summary: "2 resultado(s) para «dólar hoy»" });
    const captcha = await makeWebSearch({ fetch: async () => res("<form>anomaly detected</form>"), lookup: publicLookup }).run({ query: "x y" }, { taskId: "t" });
    expect(captcha).toMatchObject({ ok: false, summary: expect.stringMatching(/verificación humana/) });
  });
});

describe("URL helpers", () => {
  it("normalises and extracts URLs from text and JSON", () => {
    expect(normalizeUrl("HTTPS://Example.com#top")).toBe("https://example.com/");
    expect(extractUrls('Mirá https://a.example/x, y {"url":"https://b.example/y?q=1"} (https://c.example).')).toEqual(["https://a.example/x", "https://b.example/y?q=1", "https://c.example/"]);
    expect(htmlToText("<p>a&nbsp;&#225;&#x1F600;</p>").text).toBe("a á😀");
  });
});
