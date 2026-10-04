import { describe, expect, it } from "vitest";
import { VoiceStream, type StreamSend } from "./voice-stream";

describe("VoiceStream (ADR-0029)", () => {
  it("opens, sends ~200 ms PCM16 pieces while the user talks, flushes the rest on end", () => {
    const sent: Parameters<StreamSend>[0][] = [];
    const s = new VoiceStream((m) => sent.push(m), "x");
    for (let i = 0; i < 10; i++) s.push(new Float32Array(800).fill(0.5)); // 500 ms in 50 ms pieces
    expect(sent.map((m) => m.type)).toEqual(["voice.stream.start", "voice.stream.chunk", "voice.stream.chunk"]);
    s.end();
    expect(sent.map((m) => m.type).slice(-2)).toEqual(["voice.stream.chunk", "voice.stream.end"]);
    const bytes = sent.filter((m) => m.type === "voice.stream.chunk").reduce((n, m) => n + atob((m as { pcm: string }).pcm).length, 0);
    expect(bytes).toBe(8000 * 2);
    const first = atob((sent[1] as { pcm: string }).pcm);
    expect(first.charCodeAt(0) | (first.charCodeAt(1) << 8)).toBe(16384); // 0.5 -> int16 little-endian
    s.push(new Float32Array(4000));
    expect(sent.at(-1)!.type).toBe("voice.stream.end"); // nothing after end
  });

  it("cancel sends nothing more", () => {
    const sent: Parameters<StreamSend>[0][] = [];
    const s = new VoiceStream((m) => sent.push(m), "y");
    s.push(new Float32Array(100));
    s.cancel();
    s.end();
    expect(sent.map((m) => m.type)).toEqual(["voice.stream.start", "voice.stream.cancel"]);
  });
});
