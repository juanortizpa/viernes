import { MFCC_DIM, MfccExtractor, normalizeFrames } from "./mfcc";
import { subsequenceDtw } from "./dtw";
import { rms, TARGET_SAMPLE_RATE, type PcmAudio } from "./wav";

/**
 * Wake-word stage 1: compare the last ~1.4 s of audio against recordings of the user saying the wake word.
 * Deliberately permissive (it prefers a false alarm to a miss); stage 2 (transcription) removes the false alarms.
 * It is speaker-dependent by design: it learns YOUR voice saying it.
 */

export interface Enrollment {
  /** Normalised MFCC sequences of the enrolment recordings, silence trimmed. */
  templates: Float32Array[][];
  /** Score at or below which the spotter fires. */
  threshold: number;
}

const FRAME_SAMPLES = 160; // 10 ms at 16 kHz

/** Trim leading/trailing silence by energy, so the template holds only the word. */
function trimToSpeech(audio: PcmAudio): Float32Array {
  const frame = Math.round(audio.sampleRate * 0.02);
  const energies: number[] = [];
  for (let i = 0; i + frame <= audio.samples.length; i += frame) energies.push(rms(audio.samples.subarray(i, i + frame)));
  const peak = Math.max(...energies, 0);
  const floor = Math.max(0.01, peak * 0.15);
  const first = energies.findIndex((e) => e >= floor);
  let last = energies.length - 1;
  while (last > first && energies[last]! < floor) last--;
  if (first < 0) return new Float32Array(0);
  return audio.samples.subarray(Math.max(0, (first - 2) * frame), Math.min(audio.samples.length, (last + 3) * frame));
}

export function featuresOf(samples: Float32Array): Float32Array[] {
  const ex = new MfccExtractor();
  const frames = ex.push(samples);
  return normalizeFrames(frames, ex.lastRms);
}

export class EnrollmentError extends Error {}

/** Build templates from 2+ recordings (16 kHz). The threshold is calibrated from how much YOUR repetitions differ from one another. */
export function enroll(recordings: PcmAudio[]): Enrollment {
  if (recordings.length < 2) throw new EnrollmentError("Se necesitan al menos 2 grabaciones");
  const templates = recordings.map((r) => {
    if (r.sampleRate !== TARGET_SAMPLE_RATE) throw new EnrollmentError("las grabaciones deben ser de 16 kHz");
    const speech = trimToSpeech(r);
    if (speech.length < TARGET_SAMPLE_RATE * 0.3) throw new EnrollmentError("una grabación es demasiado corta o no tiene voz");
    if (speech.length > TARGET_SAMPLE_RATE * 2) throw new EnrollmentError("una grabación es demasiado larga: di solo la palabra");
    return featuresOf(speech);
  });
  // Calibrate with the SAME measure used live: score each template against the other recordings (untrimmed, as a live
  // window would be). The threshold sits above the worst of those, so the user's own repetitions fire it.
  const own: number[] = [];
  for (let i = 0; i < templates.length; i++) {
    for (let j = 0; j < recordings.length; j++) {
      if (i === j) continue;
      const ex = new MfccExtractor();
      const frames = ex.push(recordings[j]!.samples);
      own.push(subsequenceDtw(templates[i]!, normalizeFrames(frames, ex.lastRms)));
    }
  }
  const worst = Math.max(...own);
  return { templates, threshold: Math.max(0.5, worst * 1.3) };
}

export const enrollmentToJson = (e: Enrollment): string => JSON.stringify({ threshold: e.threshold, templates: e.templates.map((t) => t.map((f) => [...f])) });

export function enrollmentFromJson(json: string): Enrollment | undefined {
  try {
    const o = JSON.parse(json) as { threshold: number; templates: number[][][] };
    if (!Number.isFinite(o.threshold) || !Array.isArray(o.templates) || o.templates.length < 2) return undefined;
    const templates = o.templates.map((t) => t.map((f) => Float32Array.from(f)));
    if (templates.some((t) => t.length === 0 || t.some((f) => f.length !== MFCC_DIM))) return undefined;
    return { templates, threshold: o.threshold };
  } catch {
    return undefined;
  }
}

export interface SpotResult {
  /** Best (lowest) distance to any template; Infinity while there is not enough audio or no speech. */
  score: number;
  fired: boolean;
}

export interface SpotterOptions {
  /** Audio looked at each evaluation. */
  windowMs?: number;
  /** How often to evaluate. */
  hopMs?: number;
  /** Below this window RMS it is silence and nothing is evaluated (saves CPU, avoids matching noise floors). */
  minRms?: number;
  /** Scales the enrolled threshold: >1 is more permissive. */
  sensitivity?: number;
}

/** Streaming spotter: push 16 kHz chunks; every `hopMs` of audio it returns a score. */
export class TemplateSpotter {
  private readonly ex = new MfccExtractor();
  private frames: Float32Array[] = [];
  private frameRms: number[] = [];
  private raw: number[] = [];
  private sinceEval = 0;
  private readonly winFrames: number;
  private readonly hopSamples: number;
  private readonly minRms: number;
  readonly threshold: number;
  /** Best (lowest) score in roughly the last 3 s, for calibration displays. Infinity when there was nothing to score. */
  private recent: number[] = [];

  constructor(private readonly enrollment: Enrollment, opts: SpotterOptions = {}) {
    this.winFrames = Math.round(((opts.windowMs ?? 1400) / 1000) * 100);
    this.hopSamples = Math.round(((opts.hopMs ?? 200) / 1000) * TARGET_SAMPLE_RATE);
    this.minRms = opts.minRms ?? 0.008;
    this.threshold = enrollment.threshold * (opts.sensitivity ?? 1);
  }

  reset(): void {
    this.ex.reset();
    this.frames = [];
    this.frameRms = [];
    this.raw = [];
    this.sinceEval = 0;
    this.recent = [];
  }

  get bestRecentScore(): number {
    return this.recent.length ? Math.min(...this.recent) : Infinity;
  }

  push(chunk: Float32Array): SpotResult[] {
    const out: SpotResult[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(chunk.length - offset, this.hopSamples - this.sinceEval);
      const part = chunk.subarray(offset, offset + take);
      this.frames.push(...this.ex.push(part));
      this.frameRms.push(...this.ex.lastRms);
      for (const x of part) this.raw.push(x);
      this.sinceEval += take;
      offset += take;
      const maxRaw = this.winFrames * FRAME_SAMPLES;
      if (this.raw.length > maxRaw) this.raw = this.raw.slice(this.raw.length - maxRaw);
      if (this.frames.length > this.winFrames) {
        this.frameRms = this.frameRms.slice(this.frames.length - this.winFrames);
        this.frames = this.frames.slice(this.frames.length - this.winFrames);
      }
      if (this.sinceEval >= this.hopSamples) {
        this.sinceEval = 0;
        const r = this.evaluate();
        this.recent.push(r.score);
        if (this.recent.length > 15) this.recent.shift();
        out.push(r);
      }
    }
    return out;
  }

  private evaluate(): SpotResult {
    const minFrames = Math.min(...this.enrollment.templates.map((t) => t.length));
    if (this.frames.length < minFrames || rms(this.raw) < this.minRms) return { score: Infinity, fired: false };
    const window = normalizeFrames(this.frames, this.frameRms);
    let best = Infinity;
    for (const t of this.enrollment.templates) best = Math.min(best, subsequenceDtw(t, window));
    return { score: best, fired: best <= this.threshold };
  }
}
