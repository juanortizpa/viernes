/** Mono 16-bit PCM WAV helpers. Pure functions, no Node APIs, so the browser and the sidecar share them. */

export interface PcmAudio {
  /** Mono samples in [-1, 1]. */
  samples: Float32Array;
  sampleRate: number;
}

export const TARGET_SAMPLE_RATE = 16_000;

export function encodeWav({ samples, sampleRate }: PcmAudio): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string): void => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Decodes PCM16 WAV (any channel count, mixed down to mono). Anything else is rejected rather than guessed. */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  if (bytes.length < 44) throw new Error("wav too short");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number, n: number): string => String.fromCharCode(...bytes.subarray(o, o + n));
  if (str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") throw new Error("not a WAV file");
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let format = 0;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = str(o, 4);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === "data") {
      if (format !== 1 || bits !== 16 || channels < 1 || sampleRate < 8_000) throw new Error("unsupported WAV (need PCM 16-bit)");
      const frames = Math.floor(Math.min(size, bytes.length - body) / (2 * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += v.getInt16(body + (i * channels + c) * 2, true);
        samples[i] = sum / channels / 0x8000;
      }
      return { samples, sampleRate };
    }
    o = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/** Windowed-sinc kernel half-width, in input samples, for a given decimation ratio. */
const halfWidth = (ratio: number): number => Math.ceil(5 * ratio);

/**
 * One output sample of a low-pass decimator: windowed-sinc FIR with its cut-off at 90 % of the OUTPUT Nyquist, so energy above it
 * (which a plain average lets through and folds back into the speech band as aliasing) is removed. `get(i)` returns input sample i (0 outside).
 */
function decimateAt(get: (i: number) => number, center: number, ratio: number): number {
  const W = halfWidth(ratio);
  const fc = 0.9 / ratio;
  let acc = 0;
  let norm = 0;
  for (let k = Math.ceil(center - W); k <= Math.floor(center + W); k++) {
    const t = k - center;
    const w = sinc(fc * t) * 0.5 * (1 + Math.cos((Math.PI * t) / W));
    acc += w * get(k);
    norm += w;
  }
  return norm ? acc / norm : 0;
}

/** Position (in input samples) of output sample n: the centre of the input interval it represents. */
const centerOf = (n: number, ratio: number): number => (n + 0.5) * ratio - 0.5;

/** Anti-aliased downsampling (windowed-sinc low-pass), or linear interpolation when upsampling. */
export function resample({ samples, sampleRate }: PcmAudio, to = TARGET_SAMPLE_RATE): PcmAudio {
  if (sampleRate === to) return { samples, sampleRate };
  const ratio = sampleRate / to;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  if (ratio > 1) {
    const get = (i: number): number => (i >= 0 && i < samples.length ? samples[i]! : 0);
    for (let i = 0; i < n; i++) out[i] = decimateAt(get, centerOf(i, ratio), ratio);
  } else {
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const f = pos - j;
      out[i] = samples[j]! * (1 - f) + (samples[Math.min(j + 1, samples.length - 1)] ?? 0) * f;
    }
  }
  return { samples: out, sampleRate: to };
}

/**
 * Level an utterance for the recogniser: whisper's features are amplitude-sensitive, so a quiet voice transcribes worse than the
 * same words louder. Brings the voiced part to ~-22 dBFS RMS (at most +24 dB of gain, never clipping) and never amplifies pure noise.
 */
export function normalizeLoudness(a: PcmAudio, opts: { targetRms?: number; maxGainDb?: number } = {}): PcmAudio {
  const target = opts.targetRms ?? 0.08;
  const maxGain = 10 ** ((opts.maxGainDb ?? 24) / 20);
  const frame = Math.max(1, Math.round(a.sampleRate * 0.03));
  const voiced: number[] = [];
  let peakFrame = 0;
  const rmsFrames: number[] = [];
  for (let i = 0; i + frame <= a.samples.length; i += frame) {
    const r = rms(a.samples.subarray(i, i + frame));
    rmsFrames.push(r);
    peakFrame = Math.max(peakFrame, r);
  }
  for (const r of rmsFrames) if (r >= peakFrame * 0.25) voiced.push(r * r);
  if (voiced.length === 0 || peakFrame < 0.002) return a; // silence/noise floor: leave it alone
  const current = Math.sqrt(voiced.reduce((s, x) => s + x, 0) / voiced.length);
  let peak = 0;
  for (const x of a.samples) peak = Math.max(peak, Math.abs(x));
  const gain = Math.min(maxGain, target / current, 0.97 / Math.max(peak, 1e-9));
  if (Math.abs(gain - 1) < 0.02) return a;
  return { samples: a.samples.map((x) => x * gain), sampleRate: a.sampleRate };
}

/** Silence around the clip: a recogniser cuts the first phoneme of audio that starts abruptly. */
export function padSilence(a: PcmAudio, ms = 300): PcmAudio {
  const pad = Math.round((a.sampleRate * ms) / 1000);
  const out = new Float32Array(a.samples.length + 2 * pad);
  out.set(a.samples, pad);
  return { samples: out, sampleRate: a.sampleRate };
}

export const durationMs = (a: PcmAudio): number => Math.round((a.samples.length / a.sampleRate) * 1000);

/** RMS of the loudest `frameMs` window; also used by the UI for a real input level. */
export function rms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * Energy gate. Whisper-style models invent words ("Gracias por ver el video") on silence, so a clip with no real
 * voiced energy must never reach them. Needs `minFrames` frames of 30 ms above `threshold` RMS.
 */
export function hasSpeech(a: PcmAudio, opts: { threshold?: number; minFrames?: number } = {}): boolean {
  const threshold = opts.threshold ?? 0.012;
  const minFrames = opts.minFrames ?? 5;
  const frame = Math.max(1, Math.round(a.sampleRate * 0.03));
  let loud = 0;
  for (let i = 0; i + frame <= a.samples.length; i += frame) if (rms(a.samples.subarray(i, i + frame)) >= threshold) loud++;
  return loud >= minFrames;
}

/** Streaming version of `resample` (same filter, no state lost at chunk boundaries). Output lags the input by the filter half-width. */
export class StreamResampler {
  private buf: number[] = [];
  /** Global index of buf[0]. */
  private base = 0;
  /** Next output sample number. */
  private n = 0;

  constructor(private readonly fromRate: number, private readonly toRate = TARGET_SAMPLE_RATE) {}

  push(chunk: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return chunk;
    const ratio = this.fromRate / this.toRate;
    const W = halfWidth(ratio);
    for (const x of chunk) this.buf.push(x);
    const get = (i: number): number => {
      const j = i - this.base;
      return j >= 0 && j < this.buf.length ? this.buf[j]! : 0;
    };
    const out: number[] = [];
    for (;;) {
      const c = centerOf(this.n, ratio);
      if (Math.floor(c + W) >= this.base + this.buf.length) break; // wait for the samples the kernel still needs
      out.push(decimateAt(get, c, ratio));
      this.n++;
    }
    const keepFrom = Math.floor(centerOf(this.n, ratio) - W) - this.base;
    if (keepFrom > 0) {
      this.buf = this.buf.slice(keepFrom);
      this.base += keepFrom;
    }
    return Float32Array.from(out);
  }
}
