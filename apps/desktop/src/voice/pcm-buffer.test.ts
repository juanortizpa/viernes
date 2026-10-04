import { describe, expect, it } from "vitest";
import { decodeWav } from "@jarvis/voice/audio";
import { PcmBuffer, toBase64 } from "./pcm-buffer";

const chunk = (n: number, amp = 0.3) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i / 7));

describe("PcmBuffer", () => {
  it("produces a 16 kHz mono WAV from 48 kHz chunks and tracks the real input level", () => {
    const b = new PcmBuffer(48_000);
    for (let i = 0; i < 10; i++) b.push(chunk(4800)); // 1 s
    expect(b.ms).toBe(1000);
    expect(b.level).toBeGreaterThan(0.15);
    const wav = decodeWav(b.toWav()!);
    expect(wav.sampleRate).toBe(16_000);
    expect(wav.samples.length).toBe(16_000);
  });

  it("refuses clips too short to be speech and stops accepting audio at the maximum length", () => {
    const short = new PcmBuffer(16_000);
    short.push(chunk(1600));
    expect(short.toWav()).toBeUndefined();
    const long = new PcmBuffer(16_000);
    for (let i = 0; i < 30; i++) long.push(chunk(16_000));
    expect(long.full).toBe(true);
    expect(long.ms).toBe(20_000);
  });

  it("base64-encodes large buffers without overflowing the call stack", () => {
    const big = new Uint8Array(900_000).fill(65);
    expect(toBase64(big).length).toBe(1_200_000);
  });
});
