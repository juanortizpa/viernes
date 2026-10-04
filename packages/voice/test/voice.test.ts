import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FakeTranscriber, MAX_CLIP_MS, VoiceRejected, WhisperCppTranscriber, cleanWhisperOutput, decodeWav, durationMs, encodeWav, hasSpeech, prepareClip, resample, rms,
} from "../src";

const tone = (ms: number, rate = 16_000, amp = 0.3, hz = 220): { samples: Float32Array; sampleRate: number } => ({
  samples: Float32Array.from({ length: Math.round((ms / 1000) * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate)),
  sampleRate: rate,
});
const silence = (ms: number, rate = 16_000) => ({ samples: new Float32Array(Math.round((ms / 1000) * rate)), sampleRate: rate });

describe("wav", () => {
  it("round-trips PCM16 within quantisation error", () => {
    const a = tone(200);
    const b = decodeWav(encodeWav(a));
    expect(b.sampleRate).toBe(16_000);
    expect(b.samples.length).toBe(a.samples.length);
    expect(Math.max(...a.samples.map((x, i) => Math.abs(x - b.samples[i]!)))).toBeLessThan(1 / 16_000);
  });

  it("mixes stereo down to mono and rejects non-PCM16 input", () => {
    const wav = encodeWav(tone(100));
    const stereo = new Uint8Array(44 + 4 * 1600);
    stereo.set(wav.subarray(0, 44));
    const v = new DataView(stereo.buffer);
    v.setUint16(22, 2, true);
    v.setUint32(40, 4 * 1600, true);
    for (let i = 0; i < 1600; i++) (v.setInt16(44 + i * 4, 10_000, true), v.setInt16(46 + i * 4, -10_000, true));
    expect(decodeWav(stereo).samples.every((x) => Math.abs(x) < 1e-6)).toBe(true);
    const f32 = new Uint8Array(wav);
    new DataView(f32.buffer).setUint16(20, 3, true); // IEEE float
    expect(() => decodeWav(f32)).toThrow(/unsupported/);
    expect(() => decodeWav(new Uint8Array(10))).toThrow();
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/not a WAV/);
  });

  it("resamples 48k -> 16k keeping duration and energy, and 8k -> 16k", () => {
    const a = tone(500, 48_000);
    const b = resample(a, 16_000);
    expect(b.sampleRate).toBe(16_000);
    expect(durationMs(b)).toBe(500);
    expect(rms(b.samples)).toBeGreaterThan(0.18);
    expect(durationMs(resample(tone(500, 8_000), 16_000))).toBe(500);
  });
});

describe("hasSpeech (silence gate)", () => {
  it("passes voiced energy and blocks silence and faint noise", () => {
    expect(hasSpeech(tone(600))).toBe(true);
    expect(hasSpeech(silence(2000))).toBe(false);
    expect(hasSpeech(tone(2000, 16_000, 0.002))).toBe(false);
    expect(hasSpeech(tone(60))).toBe(false); // a click, not speech
  });
});

describe("prepareClip", () => {
  const reject = (wav: Uint8Array) => {
    try {
      prepareClip(wav);
    } catch (e) {
      return e instanceof VoiceRejected ? e.reason : "other";
    }
    return "ok";
  };
  it("normalises to 16 kHz and rejects invalid, short, long and silent clips before any engine runs", () => {
    const ok = prepareClip(encodeWav(tone(800, 48_000)));
    expect(decodeWav(ok.wav).sampleRate).toBe(16_000);
    expect(ok.audioMs).toBe(800);
    expect(reject(new Uint8Array(100))).toBe("invalid");
    expect(reject(encodeWav(tone(100)))).toBe("too_short");
    expect(reject(encodeWav(tone(MAX_CLIP_MS + 1000)))).toBe("too_long");
    expect(reject(encodeWav(silence(1500)))).toBe("silence");
  });
});

describe("FakeTranscriber", () => {
  it("records calls and returns the scripted text", async () => {
    const f = new FakeTranscriber("abre vscode");
    const r = await f.transcribe(encodeWav(tone(500)));
    expect(r.text).toBe("abre vscode");
    expect(f.calls).toHaveLength(1);
  });
});

describe("cleanWhisperOutput", () => {
  it("drops non-speech markers and collapses whitespace", () => {
    expect(cleanWhisperOutput(" [BLANK_AUDIO]\n")).toBe("");
    expect(cleanWhisperOutput("[MUSIC] Hola   mundo (música) ")).toBe("Hola mundo");
  });
});

describe("WhisperCppTranscriber (real process spawn against a stand-in binary)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-fakewhisper-"));
  /** Behaves like whisper-cli's contract: reads -f, prints text to stdout, honours -l. */
  const script = (body: string): string => {
    const p = join(dir, `w${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(p, `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nconst a = process.argv.slice(2);\nconst arg = (k) => a[a.indexOf(k) + 1];\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const wav = encodeWav(tone(500));
  const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("jarvis-stt-")).length;

  it("passes argv without a shell, returns the cleaned text, and removes its temp files", async () => {
    const before = leftovers();
    const bin = script(`if (readFileSync(arg("-f")).length < 44) process.exit(3);\nconsole.log(" [BLANK_AUDIO] Hola; $(touch /tmp/pwned) ‘" + arg("-l") + "’ " + arg("-m"));`);
    const t = new WhisperCppTranscriber({ binary: bin, model: "model with spaces.bin", language: "es" });
    const r = await t.transcribe(wav);
    expect(r.text).toBe("Hola; $(touch /tmp/pwned) ‘es’ model with spaces.bin"); // shell metacharacters stayed data
    expect(r).toMatchObject({ language: "es", audioMs: 500 });
    expect(leftovers()).toBe(before);
  });

  it("reports non-zero exit, timeouts, a missing binary and invalid languages clearly", async () => {
    const fail = new WhisperCppTranscriber({ binary: script(`console.error("model not found"); process.exit(2);`), model: "m" });
    await expect(fail.transcribe(wav)).rejects.toThrow(/code 2.*model not found/s);
    const slow = new WhisperCppTranscriber({ binary: script(`setTimeout(() => {}, 30000);`), model: "m", timeoutMs: 300 });
    await expect(slow.transcribe(wav)).rejects.toThrow(/timed out/);
    const missing = new WhisperCppTranscriber({ binary: join(dir, "nope"), model: "m" });
    await expect(missing.transcribe(wav)).rejects.toThrow(/not found/);
    expect(() => new WhisperCppTranscriber({ binary: "x", model: "m", language: "es; rm -rf /" })).toThrow(/invalid language/);
    await expect(new WhisperCppTranscriber({ binary: "x", model: "m" }).transcribe(wav, { language: "../x" })).rejects.toThrow(/invalid language/);
  });

  it("passes the vocabulary prompt as a single argv element (no shell parsing)", async () => {
    const bin = script(`console.log(a[a.indexOf("--prompt") + 1] + "|" + a.includes("--prompt"));`);
    const t = new WhisperCppTranscriber({ binary: bin, model: "m", language: "es", prompt: "Abre la calculadora; $(x) \"q\"." });
    expect((await t.transcribe(wav)).text).toBe('Abre la calculadora; $(x) "q".|true');
    const none = new WhisperCppTranscriber({ binary: script(`console.log(String(a.includes("--prompt")));`), model: "m" });
    expect((await none.transcribe(wav)).text).toBe("false");
  });

  it("can be aborted", async () => {
    const ac = new AbortController();
    const t = new WhisperCppTranscriber({ binary: script(`setTimeout(() => {}, 30000);`), model: "m" });
    const p = t.transcribe(wav, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow();
  });
});
