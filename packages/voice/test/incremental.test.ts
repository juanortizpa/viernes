import { describe, expect, it } from "vitest";
import { decodeWav, IncrementalTranscriber, SpeechActivity, VoiceRejected, type PartialTranscript, type Transcriber, type Transcript } from "../src";

const RATE = 16_000;
const tone = (ms: number, amp = 0.2): Float32Array => Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / RATE));
const silence = (ms: number): Float32Array => new Float32Array((RATE * ms) / 1000);
const tick = () => new Promise((r) => setTimeout(r, 5));

/** "Transcribes" by counting speech: one word per 400 ms of tone, so the text grows with the clip like a real partial. */
function fakeEngine(name: string, calls: { name: string; ms: number }[], conf = 0.9): Transcriber {
  return {
    async transcribe(wav) {
      const a = decodeWav(wav);
      let loud = 0;
      for (let i = 0; i < a.samples.length; i += 320) if (Math.abs(a.samples[i + 80] ?? 0) > 0.02) loud += 20;
      const ms = Math.round((a.samples.length / RATE) * 1000);
      calls.push({ name, ms });
      await tick();
      const words = Math.max(1, Math.floor(loud / 400));
      return { text: Array.from({ length: words }, (_, i) => `palabra${i + 1}`).join(" "), audioMs: ms, latencyMs: 5, confidence: conf, engine: name };
    },
  };
}
async function feed(it: IncrementalTranscriber, parts: Float32Array[]): Promise<void> {
  for (const p of parts) for (let i = 0; i < p.length; i += 3200) (it.push(p.subarray(i, i + 3200)), await tick());
}

describe("SpeechActivity", () => {
  it("tracks speech and the silence after it in audio time", () => {
    const v = new SpeechActivity();
    v.push(silence(300));
    expect(v.lastSpeechEndMs).toBe(-1);
    v.push(tone(500));
    v.push(silence(400));
    expect(v.speechMs).toBeGreaterThanOrEqual(480);
    expect(v.trailingSilenceMs).toBe(400);
  });
});

describe("IncrementalTranscriber (ADR-0029)", () => {
  it("transcribes while the user talks, and reuses the partial taken during the final pause: no extra call at the end", async () => {
    const calls: { name: string; ms: number }[] = [];
    const partials: PartialTranscript[] = [];
    const it = new IncrementalTranscriber({ partial: fakeEngine("fast", calls), final: fakeEngine("final", calls), accept: () => true, onPartial: (p) => partials.push(p) });
    await feed(it, [tone(2000), silence(400)]);
    await tick();
    const r = await it.end();
    expect(r.source).toBe("partial");
    expect(calls.filter((c) => c.name === "final")).toEqual([]);
    expect(partials.length).toBeGreaterThanOrEqual(2); // during speech, then at the pause
    expect(partials.at(-1)).toMatchObject({ complete: true });
    expect(partials.at(-1)!.text.split(" ").length).toBeGreaterThan(partials[0]!.text.split(" ").length); // it grew with the speech
    expect(r.transcript.text).toBe(partials.at(-1)!.text);
  });

  it("speech after the last partial means the full chain runs on the whole clip", async () => {
    const calls: { name: string; ms: number }[] = [];
    const it = new IncrementalTranscriber({ partial: fakeEngine("fast", calls), final: fakeEngine("final", calls), accept: () => true });
    await feed(it, [tone(1200), silence(300), tone(400)]); // spoke again after the pause partial, released mid-word
    const r = await it.end();
    expect(r.source).toBe("final");
    expect(calls.at(-1)!.name).toBe("final");
    expect(calls.at(-1)!.ms).toBeGreaterThanOrEqual(1900); // the whole clip (plus padding)
  });

  it("an untrusted partial (low confidence) is not reused", async () => {
    const calls: { name: string; ms: number }[] = [];
    const it = new IncrementalTranscriber({ partial: fakeEngine("fast", calls, 0.4), final: fakeEngine("final", calls), accept: (t) => (t.confidence ?? 0) >= 0.7 });
    await feed(it, [tone(1500), silence(400)]);
    expect((await it.end()).source).toBe("final");
  });

  it("respects the partial budget and works with no partial engine at all", async () => {
    const calls: { name: string; ms: number }[] = [];
    const none = new IncrementalTranscriber({ partial: fakeEngine("fast", calls), final: fakeEngine("final", calls), accept: () => true, allowPartial: () => false });
    await feed(none, [tone(1500), silence(400)]);
    expect((await none.end()).source).toBe("final");
    expect(calls.map((c) => c.name)).toEqual(["final"]);
    const plain = new IncrementalTranscriber({ final: fakeEngine("final", calls), accept: () => true });
    await feed(plain, [tone(800)]);
    expect((await plain.end()).transcript.engine).toBe("final");
  });

  it("silence is rejected without calling any engine; cancel stops everything", async () => {
    const calls: { name: string; ms: number }[] = [];
    const it = new IncrementalTranscriber({ partial: fakeEngine("fast", calls), final: fakeEngine("final", calls), accept: () => true });
    await feed(it, [silence(1500)]);
    await expect(it.end()).rejects.toBeInstanceOf(VoiceRejected);
    expect(calls).toEqual([]);
    const c = new IncrementalTranscriber({ partial: fakeEngine("fast", calls), final: fakeEngine("final", calls), accept: () => true });
    c.cancel();
    c.push(tone(2000));
    expect(c.audioMs).toBe(0);
  });
});
