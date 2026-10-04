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

/** Box-filter downsampling (cheap anti-aliasing) or linear interpolation when upsampling. */
export function resample({ samples, sampleRate }: PcmAudio, to = TARGET_SAMPLE_RATE): PcmAudio {
  if (sampleRate === to) return { samples, sampleRate };
  const ratio = sampleRate / to;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (ratio > 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j]!;
      out[i] = end > start ? sum / (end - start) : 0;
    } else {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const f = pos - j;
      out[i] = samples[j]! * (1 - f) + (samples[Math.min(j + 1, samples.length - 1)] ?? 0) * f;
    }
  }
  return { samples: out, sampleRate: to };
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
