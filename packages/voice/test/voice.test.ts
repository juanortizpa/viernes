import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FakeTranscriber, MAX_CLIP_MS, normalizeLoudness, padSilence, VoiceRejected, WhisperCppTranscriber, cleanWhisperOutput, decodeWav, durationMs, encodeWav, hasSpeech, prepareClip, resample, rms,
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

describe("signal quality before recognition", () => {
  const sine = (hz: number, ms: number, rate: number, amp = 0.5): Float32Array => Float32Array.from({ length: Math.round((ms / 1000) * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
  const rmsOf = (x: Float32Array): number => rms(x.subarray(Math.floor(x.length * 0.2), Math.floor(x.length * 0.8)));

  it("downsampling removes what a plain average lets alias into the speech band", () => {
    // 10 kHz at 48 kHz is above the 8 kHz Nyquist of 16 kHz: a good low-pass removes it, a box average folds it down to 6 kHz.
    const x = sine(10_000, 500, 48_000);
    const box = Float32Array.from({ length: Math.floor(x.length / 3) }, (_, i) => (x[3 * i]! + x[3 * i + 1]! + x[3 * i + 2]!) / 3);
    const good = resample({ samples: x, sampleRate: 48_000 }, 16_000).samples;
    expect(rmsOf(good)).toBeLessThan(0.02); // >28 dB below the input
    expect(rmsOf(good)).toBeLessThan(rmsOf(box) / 3); // and far better than the old method
  });

  it("keeps speech-band content intact (1 kHz passes at ~full level, 44.1 kHz too)", () => {
    for (const rate of [48_000, 44_100]) {
      const out = resample({ samples: sine(1000, 500, rate), sampleRate: rate }, 16_000).samples;
      expect(rmsOf(out)).toBeGreaterThan(0.33); // 0.5 amplitude -> 0.354 RMS
      expect(rmsOf(out)).toBeLessThan(0.37);
    }
  });

  it("levels a quiet voice up and a loud one down without clipping, and leaves noise alone", () => {
    const quiet = { samples: sine(300, 600, 16_000, 0.02), sampleRate: 16_000 };
    const up = normalizeLoudness(quiet);
    expect(rms(up.samples)).toBeGreaterThan(rms(quiet.samples) * 3);
    expect(Math.max(...up.samples.map(Math.abs))).toBeLessThanOrEqual(0.97);
    const loud = { samples: sine(300, 600, 16_000, 0.95), sampleRate: 16_000 };
    expect(Math.max(...normalizeLoudness(loud).samples.map(Math.abs))).toBeLessThanOrEqual(0.97);
    const noise = { samples: Float32Array.from({ length: 16_000 }, (_, i) => 0.0008 * Math.sin(i)), sampleRate: 16_000 };
    expect(normalizeLoudness(noise)).toBe(noise);
  });

  it("pads silence on both sides, and prepareClip delivers a levelled, padded 16 kHz clip", () => {
    const p = padSilence({ samples: new Float32Array(1600).fill(0.1), sampleRate: 16_000 }, 300);
    expect(p.samples.length).toBe(1600 + 2 * 4800);
    expect(p.samples[0]).toBe(0);
    expect(p.samples[4800]).toBeCloseTo(0.1);
    const clip = prepareClip(encodeWav({ samples: sine(250, 800, 48_000, 0.03), sampleRate: 48_000 }));
    const dec = decodeWav(clip.wav);
    expect(dec.sampleRate).toBe(16_000);
    expect(dec.samples.length).toBeGreaterThan(16_000 * 0.8 + 2 * 4800 - 10);
    expect(Math.max(...dec.samples.map(Math.abs))).toBeGreaterThan(0.1); // was 0.03
    expect(dec.samples[10]).toBe(0);
  });

  it("passes the beam size to whisper only when set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-bs-"));
    const p = join(dir, "w.mjs");
    writeFileSync(p, '#!/usr/bin/env node\nconst a = process.argv.slice(2);\nconsole.log(a.includes("-bs") ? "bs=" + a[a.indexOf("-bs") + 1] : "nobs");\n');
    chmodSync(p, 0o755);
    const wav = encodeWav({ samples: sine(220, 500, 16_000, 0.3), sampleRate: 16_000 });
    expect((await new WhisperCppTranscriber({ binary: p, model: "m", beamSize: 5 }).transcribe(wav)).text).toBe("bs=5");
    expect((await new WhisperCppTranscriber({ binary: p, model: "m" }).transcribe(wav)).text).toBe("nobs");
    expect((await new WhisperCppTranscriber({ binary: p, model: "m", beamSize: 99 }).transcribe(wav)).text).toBe("bs=10");
  });
});
