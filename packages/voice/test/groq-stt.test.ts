import { describe, expect, it } from "vitest";
import { FallbackTranscriber, FakeTranscriber, GroqTranscriber, SttRateLimited, encodeWav, type Transcriber } from "../src";

const wav = encodeWav({ samples: Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(i / 7)), sampleRate: 16_000 });

function fakeFetch(respond: (form: FormData) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const seen: { url: string; auth: string | null; form: FormData }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    seen.push({ url, auth: new Headers(init.headers).get("authorization"), form });
    const r = respond(form);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("GroqTranscriber", () => {
  it("sends the audio, model, language and vocabulary prompt; returns text, engine and a confidence", async () => {
    const { f, seen } = fakeFetch(() => ({ json: { text: " Abre la calculadora.", language: "spanish", segments: [{ text: " Abre la calculadora.", avg_logprob: -0.1, no_speech_prob: 0.01 }] } }));
    const t = await new GroqTranscriber({ apiKey: "k", language: "es", prompt: "Jarvis, abre la calculadora.", fetch: f }).transcribe(wav);
    expect(t).toMatchObject({ text: "Abre la calculadora.", engine: "groq:whisper-large-v3-turbo", audioMs: 1000 });
    expect(t.confidence).toBeCloseTo(Math.exp(-0.1));
    const s = seen[0]!;
    expect(s.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(s.auth).toBe("Bearer k");
    expect(s.form.get("model")).toBe("whisper-large-v3-turbo");
    expect(s.form.get("language")).toBe("es");
    expect(s.form.get("prompt")).toBe("Jarvis, abre la calculadora.");
    expect(s.form.get("response_format")).toBe("verbose_json");
    expect(s.form.get("file")).toBeInstanceOf(Blob);
  });

  it("drops segments whisper itself flags as non-speech (its hallucinations on noise), keeps the rest", async () => {
    const { f } = fakeFetch(() => ({ json: { text: "x", segments: [{ text: " Gracias por ver el video.", avg_logprob: -1.2, no_speech_prob: 0.9 }, { text: " qué hora es", avg_logprob: -0.2, no_speech_prob: 0.05 }] } }));
    expect((await new GroqTranscriber({ apiKey: "k", fetch: f }).transcribe(wav)).text).toBe("qué hora es");
  });

  it("omits language for auto, and turns 429 into a rate-limit error with the retry time", async () => {
    const { f, seen } = fakeFetch(() => ({ status: 429, headers: { "retry-after": "7" }, json: { error: "slow down" } }));
    const err = await new GroqTranscriber({ apiKey: "k", language: "auto", fetch: f }).transcribe(wav).catch((e) => e);
    expect(err).toBeInstanceOf(SttRateLimited);
    expect((err as SttRateLimited).retryAfterMs).toBe(7000);
    expect(seen[0]!.form.get("language")).toBeNull();
  });

  it("reports other HTTP errors", async () => {
    const { f } = fakeFetch(() => ({ status: 401, json: { error: "bad key" } }));
    await expect(new GroqTranscriber({ apiKey: "k", fetch: f }).transcribe(wav)).rejects.toThrow(/HTTP 401/);
  });
});

describe("FallbackTranscriber", () => {
  const boom = (msg = "down"): Transcriber => ({ transcribe: async () => { throw new Error(msg); } });

  it("uses the first engine that works and labels the result with it", async () => {
    const falls: string[] = [];
    const fb = new FallbackTranscriber([{ name: "cloud", engine: boom() }, { name: "local", engine: new FakeTranscriber("hola") }], { onFallback: (n) => falls.push(n) });
    expect(await fb.transcribe(wav)).toMatchObject({ text: "hola", engine: "local" });
    expect(falls).toEqual(["cloud"]);
  });

  it("skips a rate-limited engine until its retry time, then tries it again", async () => {
    let t = 0;
    let calls = 0;
    const limited: Transcriber = { transcribe: async () => { calls++; throw new SttRateLimited(10_000, "429"); } };
    const fb = new FallbackTranscriber([{ name: "cloud", engine: limited }, { name: "local", engine: new FakeTranscriber("ok") }], { now: () => t });
    await fb.transcribe(wav);
    await fb.transcribe(wav);
    expect(calls).toBe(1); // second call went straight to local
    t = 11_000;
    await fb.transcribe(wav);
    expect(calls).toBe(2);
  });

  it("throws the last error when every engine fails, and never swallows a cancellation", async () => {
    await expect(new FallbackTranscriber([{ name: "a", engine: boom("a") }, { name: "b", engine: boom("b") }]).transcribe(wav)).rejects.toThrow("b");
    const ac = new AbortController();
    ac.abort();
    const local = new FakeTranscriber("should not run");
    await expect(new FallbackTranscriber([{ name: "a", engine: boom("aborted") }, { name: "b", engine: local }]).transcribe(wav, { signal: ac.signal })).rejects.toThrow("aborted");
    expect(local.calls).toHaveLength(0);
  });
});
