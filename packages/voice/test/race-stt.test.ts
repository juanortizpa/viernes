import { describe, expect, it } from "vitest";
import { RaceTranscriber, encodeWav, type Transcriber, type Transcript } from "../src";

const wav = encodeWav({ samples: new Float32Array(16_000).fill(0.1), sampleRate: 16_000 });
const after = (ms: number, t: Partial<Transcript> | Error, log?: string[], name?: string): Transcriber => ({
  transcribe: (_w, o) =>
    new Promise((res, rej) => {
      const id = setTimeout(() => (log?.push(`${name} done`), t instanceof Error ? rej(t) : res({ audioMs: 1000, latencyMs: ms, text: "", ...t })), ms);
      o?.signal?.addEventListener("abort", () => (clearTimeout(id), log?.push(`${name} aborted`), rej(new Error("aborted"))));
    }),
});
const isCommand = (t: string) => /^abre (la )?calculadora$/i.test(t);

describe("RaceTranscriber", () => {
  it("fast path: a clear command from the quick engine is used at once, and the slow call is cancelled", async () => {
    const log: string[] = [];
    const r = new RaceTranscriber({ fast: after(20, { text: "abre la calculadora", engine: "groq" }, log, "fast"), accurate: after(300, { text: "abre la calculadora", engine: "gemini" }, log, "acc"), acceptFast: isCommand });
    const t0 = Date.now();
    const t = await r.transcribe(wav);
    expect(t.engine).toBe("groq");
    expect(Date.now() - t0).toBeLessThan(150);
    await new Promise((res) => setTimeout(res, 20));
    expect(log).toEqual(["fast done", "acc aborted"]);
  });

  it("otherwise the accurate interpretation wins", async () => {
    const r = new RaceTranscriber({ fast: after(10, { text: "abrimos el bloc de notas puesto bar" }), accurate: after(60, { text: "abrime el bloc de notas por favor", heard: "abrimos…", engine: "gemini" }), acceptFast: isCommand });
    expect(await r.transcribe(wav)).toMatchObject({ text: "abrime el bloc de notas por favor", engine: "gemini" });
  });

  it("falls back to the fast text when the accurate engine fails or is too slow, and vice versa", async () => {
    const r1 = new RaceTranscriber({ fast: after(10, { text: "qué lees" }), accurate: after(20, new Error("429")), acceptFast: isCommand });
    expect((await r1.transcribe(wav)).text).toBe("qué lees");
    const r2 = new RaceTranscriber({ fast: after(10, { text: "algo" }), accurate: after(500, { text: "tarde" }), acceptFast: isCommand, accurateTimeoutMs: 50 });
    expect((await r2.transcribe(wav)).text).toBe("algo");
    const r3 = new RaceTranscriber({ fast: after(10, new Error("groq down")), accurate: after(30, { text: "qué hora es" }), acceptFast: isCommand });
    expect((await r3.transcribe(wav)).text).toBe("qué hora es");
    const r4 = new RaceTranscriber({ fast: after(10, new Error("groq down")), accurate: after(30, new Error("gemini down")), acceptFast: isCommand });
    await expect(r4.transcribe(wav)).rejects.toThrow();
  });
});
