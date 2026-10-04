import { describe, expect, it } from "vitest";
import {
  Endpointer, MfccExtractor, StreamResampler, TemplateSpotter, WakeController, enroll, enrollmentFromJson, enrollmentToJson, matchWakeWord, normalizeFrames, resample,
  subsequenceDtw, featuresOf, type Enrollment, type WakeAction,
} from "../src";

// ---- synthetic "speech": a glottal pulse train through three formant resonators, segment by segment -------------------------
const RATE = 16_000;
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function voiced(formants: number[], f0: number, ms: number, rand: () => number): Float32Array {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  const ys = formants.map(() => [0, 0]);
  const period = Math.round(RATE / f0);
  for (let i = 0; i < n; i++) {
    const x = i % period === 0 ? 1 : 0;
    let y = 0;
    formants.forEach((f, k) => {
      const r = 0.96;
      const th = (2 * Math.PI * f) / RATE;
      const v = x + 2 * r * Math.cos(th) * ys[k]![0]! - r * r * ys[k]![1]!;
      ys[k] = [v, ys[k]![0]!];
      y += v / (k + 1);
    });
    const env = Math.min(1, i / 300, (n - i) / 300);
    out[i] = y * env * 0.012 + (rand() - 0.5) * 0.001;
  }
  return out;
}
const concat = (parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const silence = (ms: number, seed = 9): Float32Array => {
  const r = rng(seed);
  return Float32Array.from({ length: Math.round((ms / 1000) * RATE) }, () => (r() - 0.5) * 0.004);
};
type Word = number[][];
/** Scale to a plausible speech loudness. */
const loud = (x: Float32Array, to = 0.25): Float32Array => {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  return peak ? x.map((v) => (v / peak) * to) : x;
};
const say = (w: Word, o: { tempo?: number; f0?: number; seed?: number } = {}): Float32Array => {
  const r = rng(o.seed ?? 1);
  return loud(concat(w.map((f, i) => voiced(f.map((x) => x * (1 + (r() - 0.5) * 0.04)), (o.f0 ?? 120) * (1 + (r() - 0.5) * 0.04), 95 * (o.tempo ?? 1) * (1 + (i % 2 ? 0.2 : -0.1)), r))));
};
const JARVIS: Word = [[300, 2200, 3000], [700, 1200, 2600], [450, 1800, 2700], [800, 1300, 2500], [350, 1500, 2400], [500, 2000, 3000]];
const OTHER: Word = [[800, 1100, 2500], [300, 900, 2300], [600, 1700, 2600], [350, 2300, 3000], [700, 1000, 2700], [450, 1400, 2500]];
const COMMAND: Word = [[600, 1500, 2500], [400, 2000, 2900], [750, 1100, 2400], [500, 1700, 2800], [300, 2300, 3100], [650, 1300, 2600], [450, 1900, 2700], [700, 1000, 2500]];
const pcm = (samples: Float32Array) => ({ samples, sampleRate: RATE });

const enrollment = (): Enrollment => enroll([say(JARVIS, { tempo: 0.9, f0: 110, seed: 3 }), say(JARVIS, { tempo: 1, f0: 120, seed: 4 }), say(JARVIS, { tempo: 1.1, f0: 130, seed: 5 })].map((s) => pcm(concat([silence(200), s, silence(200)]))));

describe("StreamResampler", () => {
  it("matches the batch resampler regardless of chunking, for 48k and 44.1k", () => {
    for (const from of [48_000, 44_100]) {
      const x = Float32Array.from({ length: from }, (_, i) => Math.sin(i / 17));
      const batch = resample({ samples: x, sampleRate: from }, 16_000).samples;
      const rs = new StreamResampler(from);
      const parts: Float32Array[] = [];
      for (let i = 0; i < x.length; ) {
        const n = 100 + ((i * 7) % 900);
        parts.push(rs.push(x.subarray(i, i + n)));
        i += n;
      }
      const streamed = concat(parts);
      expect(Math.abs(streamed.length - batch.length)).toBeLessThanOrEqual(1);
      for (let i = 0; i < Math.min(batch.length, streamed.length) - 1; i++) expect(streamed[i]).toBeCloseTo(batch[i]!, 5);
    }
  });
});

describe("MFCC / DTW", () => {
  it("emits the expected frame count with finite values, and normalisation centres them", () => {
    const frames = new MfccExtractor().push(say(JARVIS));
    expect(frames.length).toBeGreaterThan(40);
    expect(frames.every((f) => f.length === 12 && f.every(Number.isFinite))).toBe(true);
    const n = normalizeFrames(frames);
    expect(Math.abs(n.reduce((s, f) => s + f[0]!, 0) / n.length)).toBeLessThan(1e-3);
  });

  it("DTW ranks the same word (even faster/slower) closer than a different word", () => {
    const tpl = featuresOf(say(JARVIS, { seed: 4 }));
    const d = (w: Word, o = {}) => {
      const ex = new MfccExtractor();
      const frames = ex.push(concat([silence(300), say(w, o), silence(300)]));
      return subsequenceDtw(tpl, normalizeFrames(frames, ex.lastRms));
    };
    const same = d(JARVIS, { tempo: 1.15, f0: 128, seed: 21 });
    const other = d(OTHER, { seed: 21 });
    expect(same).toBeLessThan(other);
  });
});

describe("TemplateSpotter (stage 1)", () => {
  const run = (audio: Float32Array, sensitivity = 1) => {
    const sp = new TemplateSpotter(enrollment(), { sensitivity });
    const results = [];
    for (let i = 0; i < audio.length; i += 3200) results.push(...sp.push(audio.subarray(i, i + 3200)));
    return results;
  };
  const wrap = (w: Float32Array) => concat([silence(1200), w, silence(1200)]);

  it("fires on the enrolled word said in a new way, and not on another word, plain noise, or silence", () => {
    expect(run(wrap(say(JARVIS, { tempo: 1.05, f0: 124, seed: 33 }))).some((r) => r.fired)).toBe(true);
    expect(run(wrap(say(OTHER, { seed: 34 }))).some((r) => r.fired)).toBe(false);
    expect(run(wrap(say(COMMAND, { seed: 35 }))).some((r) => r.fired)).toBe(false);
    expect(run(silence(4000)).some((r) => r.fired)).toBe(false);
  });

  it("scores silence as Infinity (nothing evaluated) and evaluates every ~200 ms", () => {
    const r = run(silence(2000));
    expect(r.length).toBeGreaterThanOrEqual(9);
    expect(r.every((x) => x.score === Infinity)).toBe(true);
  });

  it("rejects bad enrolments and round-trips through JSON", () => {
    expect(() => enroll([pcm(say(JARVIS))])).toThrow(/al menos 2/);
    expect(() => enroll([pcm(silence(1000)), pcm(silence(1000))])).toThrow(/corta|voz/);
    expect(() => enroll([pcm(say(JARVIS)), pcm(concat([say(JARVIS), say(OTHER), say(JARVIS), say(OTHER), say(JARVIS)]))])).toThrow(/larga/);
    const e = enrollment();
    const back = enrollmentFromJson(enrollmentToJson(e))!;
    expect(back.threshold).toBeCloseTo(e.threshold);
    expect(back.templates).toHaveLength(3);
    expect(enrollmentFromJson("not json")).toBeUndefined();
    expect(enrollmentFromJson('{"threshold":1,"templates":[[[1,2]],[[1,2]]]}')).toBeUndefined();
  });
});

describe("Endpointer", () => {
  const feed = (ep: Endpointer, a: Float32Array) => {
    for (let i = 0; i < a.length; i += 1600) ep.push(a.subarray(i, i + 1600));
  };
  it("ends an utterance after silence and returns it with a little pre-roll, not the whole silence", () => {
    const ep = new Endpointer();
    feed(ep, concat([silence(1000), say(COMMAND), silence(1500)]));
    expect(ep.state).toBe("ended");
    const u = ep.take()!;
    const speechMs = (say(COMMAND).length / RATE) * 1000;
    expect(u.length / RATE * 1000).toBeGreaterThan(speechMs);
    expect(u.length / RATE * 1000).toBeLessThan(speechMs + 700);
  });
  it("ignores a click and caps a monologue", () => {
    const click = new Endpointer();
    feed(click, concat([silence(500), loud(voiced([500, 1500, 2500], 120, 60, rng(1))), silence(1500)]));
    expect(click.state).toBe("silence");
    const long = new Endpointer({ maxMs: 3000 });
    feed(long, concat([silence(300), say(COMMAND, { tempo: 8 })]));
    expect(long.state).toBe("ended");
  });
});

describe("matchWakeWord", () => {
  it.each([
    ["Jarvis", true, ""],
    ["Jarvis, abre la calculadora", true, "abre la calculadora"],
    ["jarvis qué hora es", true, "qué hora es"],
    ["Hey Jarvis, what time is it?", true, "what time is it?"],
    ["oye jarvis por favor abre paint", true, "abre paint"],
    ["Yarvis abre el bloc de notas", true, "abre el bloc de notas"],
    ["Harvis.", true, ""],
    ["le dije a jarvis que abriera paint", false, ""],
    ["abre jarvis", false, ""],
    ["carvajal abre algo", false, ""],
    ["", false, ""],
    ["gracias por ver el video", false, ""],
  ])("%s", (t, matched, rest) => {
    expect(matchWakeWord(t)).toEqual({ matched, rest });
  });
});

// ---- the listening loop ---------------------------------------------------------------------------------------------------------
function rig(opts: { enrolled?: boolean; followUpMs?: number } = {}) {
  let t = 1_000_000;
  const ctl = new WakeController({ enrollment: opts.enrolled === false ? undefined : enrollment(), now: () => t, followUpMs: opts.followUpMs });
  const log: WakeAction[] = [];
  const feed = (a: Float32Array) => {
    for (let i = 0; i < a.length; i += 3200) {
      const chunk = a.subarray(i, i + 3200);
      t += (chunk.length / RATE) * 1000;
      log.push(...ctl.onAudio(chunk));
    }
  };
  const wait = (ms: number) => feed(silence(ms));
  const states = () => log.flatMap((a) => (a.type === "state" ? [a.state] : []));
  const take = <T extends WakeAction["type"]>(type: T) => log.filter((a): a is Extract<WakeAction, { type: T }> => a.type === type);
  return { ctl, log, feed, wait, states, take, now: () => t, advance: (ms: number) => (t += ms) };
}

describe("WakeController", () => {
  it("full conversation: wake word -> verify -> command -> follow-up without the wake word -> back to idle after 10 s", () => {
    const r = rig();
    r.log.push(...r.ctl.start());
    r.wait(1500);
    r.feed(say(JARVIS, { tempo: 1.03, f0: 123, seed: 50 }));
    r.wait(1200);
    expect(r.take("verify")).toHaveLength(1);
    expect(r.ctl.state).toBe("verifying");

    r.log.push(...r.ctl.onVerified({ detected: true, commandRan: false }));
    expect(r.ctl.state).toBe("command");
    r.wait(500);
    r.feed(say(COMMAND, { seed: 51 }));
    r.wait(1200);
    expect(r.take("command").map((c) => c.source)).toEqual(["wake"]);
    expect(r.ctl.state).toBe("busy");

    r.log.push(...r.ctl.onTaskDone({ fromVoice: true }));
    expect(r.ctl.state).toBe("followUp");
    expect(r.take("state").at(-1)).toMatchObject({ state: "followUp", followUpMs: 10_000 });
    r.wait(3000);
    r.feed(say(COMMAND, { seed: 52 })); // no wake word
    r.wait(1200);
    expect(r.take("command").map((c) => c.source)).toEqual(["wake", "followUp"]);
    expect(r.ctl.state).toBe("busy");

    r.log.push(...r.ctl.onTaskDone({ fromVoice: true }));
    r.wait(10_500);
    expect(r.ctl.state).toBe("idle");
    // After the window, speech that is not the wake word is ignored again.
    r.feed(say(COMMAND, { seed: 53 }));
    r.wait(1200);
    expect(r.take("command")).toHaveLength(2);
    expect(r.take("verify")).toHaveLength(1);
  });

  it("counts down the follow-up window with real remaining time", () => {
    const r = rig();
    r.log.push(...r.ctl.start(), ...r.ctl.onTaskStarted(), ...r.ctl.onTaskDone({ fromVoice: true }));
    r.wait(4000);
    const left = r.take("state").filter((s) => s.state === "followUp").map((s) => s.followUpMs!);
    expect(left[0]).toBe(10_000);
    expect(left.at(-1)!).toBeLessThanOrEqual(6_500);
    expect(left.at(-1)!).toBeGreaterThan(5_000);
  });

  it("does not verify an utterance stage 1 did not like (no transcription, nothing leaves the loop)", () => {
    const r = rig();
    r.log.push(...r.ctl.start());
    r.wait(1000);
    r.feed(say(OTHER, { seed: 60 }));
    r.wait(1200);
    expect(r.take("verify")).toHaveLength(0);
    expect(r.take("discard").map((d) => d.reason)).toEqual(["not-for-me"]);
    expect(r.ctl.state).toBe("idle");
  });

  it("without enrolment (vad mode) verifies every utterance, and returns to idle when it was not the wake word", () => {
    const r = rig({ enrolled: false });
    expect(r.ctl.stage1).toBe("vad");
    r.log.push(...r.ctl.start());
    r.wait(800);
    r.feed(say(OTHER, { seed: 61 }));
    r.wait(1200);
    expect(r.take("verify")).toHaveLength(1);
    r.log.push(...r.ctl.onVerified({ detected: false, commandRan: false }));
    expect(r.ctl.state).toBe("idle");
  });

  it("wake word and command in one breath: the sidecar already ran it, so no second capture", () => {
    const r = rig({ enrolled: false });
    r.log.push(...r.ctl.start());
    r.wait(500);
    r.feed(say(JARVIS, { seed: 62 }));
    r.wait(1200);
    r.log.push(...r.ctl.onVerified({ detected: true, commandRan: true }));
    expect(r.ctl.state).toBe("busy");
    expect(r.take("command")).toHaveLength(0);
  });

  it("gives up if the wake word is said but no command follows within the wait", () => {
    const r = rig({ enrolled: false });
    r.log.push(...r.ctl.start());
    r.wait(500);
    r.feed(say(JARVIS, { seed: 63 }));
    r.wait(1200);
    r.log.push(...r.ctl.onVerified({ detected: true, commandRan: false }));
    r.wait(6_500);
    expect(r.ctl.state).toBe("idle");
    expect(r.take("discard").map((d) => d.reason)).toContain("timeout");
  });

  it("never hears its own voice: audio is dropped while speaking, and the follow-up window opens only after the answer is spoken", () => {
    const r = rig();
    r.log.push(...r.ctl.start(), ...r.ctl.onTaskStarted());
    r.log.push(...r.ctl.onSpeaking(true));
    r.log.push(...r.ctl.onTaskDone({ fromVoice: true }));
    expect(r.ctl.state).toBe("busy"); // waiting for the speech to end
    r.feed(say(COMMAND, { seed: 64 })); // the assistant's own voice leaking into the microphone
    r.wait(2000);
    expect(r.take("command")).toHaveLength(0);
    r.log.push(...r.ctl.onSpeaking(false));
    expect(r.ctl.state).toBe("followUp");
    expect(r.take("state").at(-1)).toMatchObject({ followUpMs: 10_000 });
  });

  it("a typed task does not reopen the microphone, and stop() turns everything off", () => {
    const r = rig();
    r.log.push(...r.ctl.start(), ...r.ctl.onTaskStarted(), ...r.ctl.onTaskDone({ fromVoice: false }));
    expect(r.ctl.state).toBe("idle");
    r.log.push(...r.ctl.stop());
    expect(r.ctl.state).toBe("off");
    r.feed(say(JARVIS, { seed: 65 }));
    r.wait(1500);
    expect(r.take("verify")).toHaveLength(0);
  });

  it("recovers from a lost verification answer", () => {
    const r = rig({ enrolled: false });
    r.log.push(...r.ctl.start());
    r.wait(500);
    r.feed(say(JARVIS, { seed: 66 }));
    r.wait(1200);
    expect(r.ctl.state).toBe("verifying");
    r.wait(21_000);
    expect(r.ctl.state).toBe("idle");
  });
});
