import { prepareClip, type Transcriber } from "@jarvis/voice";

/** Calibration of speech recognition on the USER's own recordings (ADR-0019): pure pieces, so they can be tested without audio. */

export const normalizeForWer = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Word error rate against the reference (accents, case and punctuation ignored). 0 = perfect; can exceed 1 with extra words. */
export function wer(reference: string, hypothesis: string): number {
  const r = normalizeForWer(reference);
  const h = normalizeForWer(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  return editDistance(r, h) / r.length;
}

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

export interface Clip {
  id: string;
  reference: string;
  /** How it was captured: with the browser's audio processing on or off. */
  mode: string;
  wav: Uint8Array;
}

export interface BenchConfig {
  label: string;
  /** Apply the production pre-processing (levelling + padding) or feed the clip as recorded. */
  prepared: boolean;
  /** Builds the engine for this configuration. */
  make: () => Transcriber;
}

export interface BenchRow {
  label: string;
  wer: number;
  /** Fraction of clips transcribed exactly (after normalisation). */
  exact: number;
  medianMs: number;
  p95Ms: number;
  runs: number;
  /** WER split by capture mode. */
  byMode: Record<string, number>;
  failures: number;
}

export async function runConfig(cfg: BenchConfig, clips: readonly Clip[]): Promise<BenchRow> {
  const engine = cfg.make();
  const errs: number[] = [];
  const times: number[] = [];
  const byMode = new Map<string, number[]>();
  let exact = 0;
  let failures = 0;
  for (const c of clips) {
    try {
      const wav = cfg.prepared ? prepareClip(c.wav).wav : c.wav;
      const t0 = performance.now();
      const r = await engine.transcribe(wav);
      times.push(performance.now() - t0);
      const e = wer(c.reference, r.text);
      errs.push(e);
      if (e === 0) exact++;
      byMode.set(c.mode, [...(byMode.get(c.mode) ?? []), e]);
    } catch {
      failures++;
      errs.push(1); // a clip that could not be transcribed counts as completely wrong
      byMode.set(c.mode, [...(byMode.get(c.mode) ?? []), 1]);
    }
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    label: cfg.label,
    wer: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 1,
    exact: clips.length ? exact / clips.length : 0,
    medianMs: Math.round(median(times)),
    p95Ms: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0),
    runs: clips.length,
    byMode: Object.fromEntries([...byMode].map(([m, e]) => [m, e.reduce((a, b) => a + b, 0) / e.length])),
    failures,
  };
}

export const fmtPct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function renderTable(rows: readonly BenchRow[]): string {
  const modes = [...new Set(rows.flatMap((r) => Object.keys(r.byMode)))].sort();
  const head = ["Configuración", "Error de palabras", ...modes.map((m) => `(${m})`), "Frases exactas", "Latencia mediana", "p95", "Fallos"];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of [...rows].sort((a, b) => a.wer - b.wer || a.medianMs - b.medianMs))
    lines.push(`| ${[r.label, fmtPct(r.wer), ...modes.map((m) => (r.byMode[m] === undefined ? "—" : fmtPct(r.byMode[m]!))), fmtPct(r.exact), `${r.medianMs} ms`, `${r.p95Ms} ms`, r.failures].join(" | ")} |`);
  return lines.join("\n");
}

/**
 * Coordinate search instead of the full cross product: pick the best model with the baseline settings, then vary ONE factor at a
 * time around it. M + 3 configurations instead of M x 8, which is minutes instead of an hour on a laptop CPU.
 */
export interface Axes<M> {
  models: readonly M[];
  modelLabel: (m: M) => string;
  make: (o: { model: M; prompt: boolean; beam: number }) => Transcriber;
  baseline: { prepared: boolean; prompt: boolean; beam: number };
}

export async function searchBest<M>(axes: Axes<M>, clips: readonly Clip[], onRow?: (row: BenchRow) => void): Promise<{ rows: BenchRow[]; best: { model: M; prepared: boolean; prompt: boolean; beam: number } }> {
  const rows: BenchRow[] = [];
  const base = axes.baseline;
  const label = (m: M, o: { prepared: boolean; prompt: boolean; beam: number }): string =>
    `${axes.modelLabel(m)} · ${o.prepared ? "nivelado+margen" : "sin procesar"} · ${o.prompt ? "con prompt" : "sin prompt"} · beam ${o.beam}`;
  const run = async (model: M, o: { prepared: boolean; prompt: boolean; beam: number }): Promise<BenchRow> => {
    const row = await runConfig({ label: label(model, o), prepared: o.prepared, make: () => axes.make({ model, prompt: o.prompt, beam: o.beam }) }, clips);
    rows.push(row);
    onRow?.(row);
    return row;
  };
  let bestModel: M = axes.models[0] as M;
  let bestRow: BenchRow | undefined;
  for (const m of axes.models) {
    const r = await run(m, base);
    if (!bestRow || r.wer < bestRow.wer - 1e-9 || (Math.abs(r.wer - bestRow.wer) < 1e-9 && r.medianMs < bestRow.medianMs)) {
      bestRow = r;
      bestModel = m;
    }
  }
  let best = { ...base };
  const variants: { key: "prepared" | "prompt" | "beam"; value: boolean | number }[] = [
    { key: "prepared", value: !base.prepared },
    { key: "prompt", value: !base.prompt },
    { key: "beam", value: base.beam === 1 ? 5 : 1 },
  ];
  for (const v of variants) {
    const cfg = { ...base, [v.key]: v.value };
    const r = await run(bestModel, cfg);
    if (bestRow && r.wer < bestRow.wer - 1e-9) (bestRow = r), (best = { ...best, [v.key]: v.value });
  }
  return { rows, best: { model: bestModel, ...best } };
}
