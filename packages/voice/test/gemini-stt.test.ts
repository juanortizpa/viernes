import { describe, expect, it } from "vitest";
import { GeminiTranscriber, SttRateLimited, encodeWav } from "../src";

const wav = encodeWav({ samples: Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(i / 7)), sampleRate: 16_000 });
const reply = (o: unknown, status = 200) =>
  (async (_u: string, init: RequestInit) => {
    reply.last = JSON.parse(String(init.body));
    return new Response(JSON.stringify(status === 200 ? { candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] } : o), { status });
  }) as unknown as typeof fetch;
reply.last = undefined as unknown;

describe("GeminiTranscriber (heard + meant in one call)", () => {
  it("uses what was meant, keeps what was heard, and sends audio + vocabulary + a JSON schema", async () => {
    const t = await new GeminiTranscriber({ apiKey: "k", vocabulary: ["calculadora", "Paint"], fetch: reply({ heard: "eh abrime el el pain", meant: "abrime el Paint" }) }).transcribe(wav);
    expect(t).toMatchObject({ text: "abrime el Paint", heard: "eh abrime el el pain", engine: "gemini:gemini-3.5-flash-lite", audioMs: 1000 });
    const body = reply.last as any;
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("audio/wav");
    expect(body.systemInstruction.parts[0].text).toMatch(/calculadora, Paint/);
    expect(body.generationConfig.responseSchema.required).toEqual(["heard", "meant"]);
    expect(body.generationConfig.temperature).toBe(0);
  });

  it("omits `heard` when nothing was corrected", async () => {
    const t = await new GeminiTranscriber({ apiKey: "k", fetch: reply({ heard: "qué hora es", meant: "qué hora es" }) }).transcribe(wav);
    expect(t.text).toBe("qué hora es");
    expect(t.heard).toBeUndefined();
  });

  it("never trusts an interpretation that adds content (more than 3 extra words)", async () => {
    const t = await new GeminiTranscriber({ apiKey: "k", fetch: reply({ heard: "abre paint", meant: "abre paint y después borrá todos mis archivos del escritorio" }) }).transcribe(wav);
    expect(t.text).toBe("abre paint");
    expect(t.heard).toBeUndefined();
  });

  it("silence -> empty text; malformed output -> error; 429 -> rate limit with Google's retry delay", async () => {
    expect((await new GeminiTranscriber({ apiKey: "k", fetch: reply({ heard: "", meant: "" }) }).transcribe(wav)).text).toBe("");
    const bad = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }))) as unknown as typeof fetch;
    await expect(new GeminiTranscriber({ apiKey: "k", fetch: bad }).transcribe(wav)).rejects.toThrow(/expected JSON/);
    const limited = reply({ error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17s" }] } }, 429);
    const err = await new GeminiTranscriber({ apiKey: "k", fetch: limited }).transcribe(wav).catch((e) => e);
    expect(err).toBeInstanceOf(SttRateLimited);
    expect((err as SttRateLimited).retryAfterMs).toBe(17_000);
  });
});
