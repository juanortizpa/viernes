/**
 * MFCC features for the first wake-word stage: tiny, dependency-free, a few hundred floating-point ops per 10 ms frame.
 * 16 kHz mono in; 12 coefficients (c1..c12) per frame out.
 */

export const MFCC_DIM = 12;

export interface MfccConfig {
  sampleRate?: number;
  frameMs?: number;
  hopMs?: number;
  nMel?: number;
}

const N_FFT = 512;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]!;
        const ai = im[i + k]!;
        const br = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const bi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const hz2mel = (f: number): number => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number): number => 700 * (10 ** (m / 2595) - 1);

function melBank(rate: number, nMel: number): Float64Array[] {
  const lo = hz2mel(100);
  const hi = hz2mel(rate / 2);
  const pts = Array.from({ length: nMel + 2 }, (_, i) => Math.floor(((N_FFT + 1) * mel2hz(lo + ((hi - lo) * i) / (nMel + 1))) / rate));
  return Array.from({ length: nMel }, (_, m) => {
    const f = new Float64Array(N_FFT / 2 + 1);
    for (let k = pts[m]!; k < pts[m + 1]!; k++) f[k] = (k - pts[m]!) / Math.max(1, pts[m + 1]! - pts[m]!);
    for (let k = pts[m + 1]!; k < pts[m + 2]!; k++) f[k] = (pts[m + 2]! - k) / Math.max(1, pts[m + 2]! - pts[m + 1]!);
    return f;
  });
}

/** Incremental extractor: push audio of any chunk size, receive the MFCC frames that became complete. */
export class MfccExtractor {
  private readonly frame: number;
  private readonly hop: number;
  private readonly window: Float64Array;
  private readonly bank: Float64Array[];
  private readonly dct: Float64Array[];
  private buf: number[] = [];
  private prev = 0;
  /** RMS of the frames returned by the most recent `push` (same order), used to find the voiced ones. */
  lastRms: number[] = [];

  constructor(cfg: MfccConfig = {}) {
    const rate = cfg.sampleRate ?? 16_000;
    this.frame = Math.round((rate * (cfg.frameMs ?? 25)) / 1000);
    this.hop = Math.round((rate * (cfg.hopMs ?? 10)) / 1000);
    const nMel = cfg.nMel ?? 26;
    this.window = Float64Array.from({ length: this.frame }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (this.frame - 1)));
    this.bank = melBank(rate, nMel);
    this.dct = Array.from({ length: MFCC_DIM }, (_, c) => Float64Array.from({ length: nMel }, (_, m) => Math.cos((Math.PI * (c + 1) * (m + 0.5)) / nMel)));
  }

  reset(): void {
    this.buf = [];
    this.prev = 0;
  }

  push(samples: Float32Array): Float32Array[] {
    for (const x of samples) this.buf.push(x);
    const out: Float32Array[] = [];
    this.lastRms = [];
    let start = 0;
    while (start + this.frame <= this.buf.length) {
      let e = 0;
      for (let i = 0; i < this.frame; i++) e += this.buf[start + i]! ** 2;
      this.lastRms.push(Math.sqrt(e / this.frame));
      out.push(this.compute(start));
      start += this.hop;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  private compute(start: number): Float32Array {
    const re = new Float64Array(N_FFT);
    const im = new Float64Array(N_FFT);
    let prev = start === 0 ? this.prev : this.buf[start - 1]!;
    for (let i = 0; i < this.frame; i++) {
      const x = this.buf[start + i]!;
      re[i] = (x - 0.97 * prev) * this.window[i]!; // pre-emphasis
      prev = x;
    }
    this.prev = this.buf[start + this.hop - 1] ?? 0;
    fft(re, im);
    const power = new Float64Array(N_FFT / 2 + 1);
    for (let k = 0; k < power.length; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    const logMel = this.bank.map((f) => {
      let e = 0;
      for (let k = 0; k < f.length; k++) e += f[k]! * power[k]!;
      return Math.log(e + 1e-10);
    });
    return Float32Array.from(this.dct, (row) => {
      let s = 0;
      for (let m = 0; m < row.length; m++) s += row[m]! * logMel[m]!;
      return s;
    });
  }
}

/**
 * Mean/variance normalisation computed over the VOICED frames only (those within 25 % of the loudest), then applied to all.
 * Silence around a word must not change how the word itself is normalised, or a template and a live window would not compare.
 */
export function normalizeFrames(frames: Float32Array[], frameRms?: readonly number[]): Float32Array[] {
  if (frames.length === 0) return frames;
  const dim = frames[0]!.length;
  const peak = frameRms ? Math.max(...frameRms) : 0;
  const voiced = frames.filter((_, i) => !frameRms || frameRms[i]! >= peak * 0.25);
  const basis = voiced.length >= 10 ? voiced : frames;
  const mean = new Float64Array(dim);
  for (const f of basis) for (let d = 0; d < dim; d++) mean[d]! += f[d]! / basis.length;
  const sd = new Float64Array(dim);
  for (const f of basis) for (let d = 0; d < dim; d++) sd[d]! += (f[d]! - mean[d]!) ** 2 / basis.length;
  return frames.map((f) => Float32Array.from(f, (v, d) => (v - mean[d]!) / (Math.sqrt(sd[d]!) + 1e-3)));
}
