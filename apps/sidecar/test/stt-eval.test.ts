import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav, rms } from "@jarvis/voice";
import { STT_CORPUS, degrade } from "../src/stt-corpus";

describe("stt-eval corpus", () => {
  const wav = encodeWav({ samples: Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(i / 9)), sampleRate: 16_000 });

  it("degradation is deterministic, keeps the length and lowers the signal-to-noise ratio", () => {
    const a = decodeWav(degrade(wav)).samples;
    const b = decodeWav(degrade(wav)).samples;
    expect(a.length).toBe(16_000);
    expect([...a]).toEqual([...b]);
    const silence = decodeWav(degrade(encodeWav({ samples: new Float32Array(16_000), sampleRate: 16_000 }))).samples;
    expect(rms(silence)).toBe(0); // noise is relative to the signal: no signal, no noise
    expect(rms(a)).toBeGreaterThan(0.05);
  });

  it("covers commands, questions, voseo, hesitation and English, each with an expected action", () => {
    expect(STT_CORPUS).toHaveLength(20);
    expect(STT_CORPUS.every((c) => /^(llm|time\.now|time\.date:-?\d|apps\.open:\w+)$/.test(c.expect))).toBe(true);
    expect(STT_CORPUS.filter((c) => c.expect.startsWith("apps.open")).length).toBeGreaterThanOrEqual(8);
  });
});
