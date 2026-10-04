import { describe, expect, it } from "vitest";
import { FakeTranscriber, encodeWav, type Transcriber } from "@jarvis/voice";
import { median, renderTable, runConfig, searchBest, wer, type Clip } from "../src/bench-lib";

const tone = (ms = 800): Uint8Array => encodeWav({ samples: Float32Array.from({ length: Math.round((ms / 1000) * 16_000) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16_000)), sampleRate: 16_000 });
const clip = (id: string, reference: string, mode = "dsp-on"): Clip => ({ id, reference, mode, wav: tone() });

describe("wer", () => {
  it("ignores accents, case and punctuation and counts substitutions, deletions and insertions", () => {
    expect(wer("Abre la calculadora", "abre la calculadora.")).toBe(0);
    expect(wer("¿Qué hora es?", "que hora es")).toBe(0);
    expect(wer("abre la calculadora", "abre la calculador")).toBeCloseTo(1 / 3);
    expect(wer("abre la calculadora", "abre calculadora")).toBeCloseTo(1 / 3);
    expect(wer("abre la calculadora", "abre la calculadora por favor")).toBeCloseTo(2 / 3); // two inserted words
    expect(wer("abre la calculadora", "")).toBe(1);
    expect(wer("", "")).toBe(0);
  });
  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("runConfig", () => {
  it("scores each clip, splits by capture mode and counts engine failures as fully wrong", async () => {
    const clips = [clip("1", "abre la calculadora", "dsp-on"), clip("2", "qué hora es", "dsp-off"), clip("3", "hola", "dsp-off")];
    let n = 0;
    const engine: Transcriber = {
      transcribe: async () => {
        n++;
        if (n === 3) throw new Error("boom");
        return { text: n === 1 ? "abre la calculadora" : "que hora", audioMs: 1, latencyMs: 1 };
      },
    };
    const row = await runConfig({ label: "x", prepared: false, make: () => engine }, clips);
    expect(row.failures).toBe(1);
    expect(row.exact).toBeCloseTo(1 / 3);
    expect(row.byMode["dsp-on"]).toBe(0);
    expect(row.byMode["dsp-off"]).toBeCloseTo((1 / 3 + 1) / 2); // "que hora" vs "qué hora es": one deletion in three words; the crash counts as 1
    expect(row.wer).toBeCloseTo((0 + 1 / 3 + 1) / 3);
  });

  it("silent clips fail the production pre-processing but not the raw feed (they count as failures, not crashes)", async () => {
    const silent: Clip = { id: "s", reference: "hola", mode: "dsp-on", wav: encodeWav({ samples: new Float32Array(16_000), sampleRate: 16_000 }) };
    const row = await runConfig({ label: "p", prepared: true, make: () => new FakeTranscriber("hola") }, [silent]);
    expect(row.failures).toBe(1);
    const raw = await runConfig({ label: "r", prepared: false, make: () => new FakeTranscriber("hola") }, [silent]);
    expect(raw.failures).toBe(0);
  });
});

describe("searchBest (coordinate search)", () => {
  it("picks the most accurate model, then changes one factor at a time and keeps only changes that help", async () => {
    const clips = [clip("1", "abre la calculadora"), clip("2", "qué hora es"), clip("3", "decime qué día es mañana")];
    // Fake engines whose accuracy depends on (model, prompt): small beats base, and the prompt helps small. Beam changes nothing.
    // Engines are built per configuration and called in clip order, so the call counter identifies the clip.
    const degrade = (ref: string, drop: number): string => ref.split(" ").slice(0, Math.max(1, ref.split(" ").length - drop)).join(" ");
    const make = ({ model, prompt }: { model: string; prompt: boolean; beam: number }): Transcriber => {
      let i = 0;
      return {
        transcribe: async () => {
          const ref = clips[i++]!.reference;
          const drop = model === "small" ? (prompt ? 0 : 1) : 2;
          return { text: degrade(ref, drop), audioMs: 1, latencyMs: 1 };
        },
      };
    };
    const calls: string[] = [];
    const { rows, best } = await searchBest({ models: ["base", "small"], modelLabel: (m) => m, make, baseline: { prepared: true, prompt: false, beam: 5 } }, clips, (r) => calls.push(r.label));
    expect(best).toEqual({ model: "small", prepared: true, prompt: true, beam: 5 });
    expect(rows).toHaveLength(2 + 3); // models, then one variant per factor
    expect(calls[0]).toMatch(/^base/);
    expect(renderTable(rows)).toMatch(/Error de palabras/);
  });
});
