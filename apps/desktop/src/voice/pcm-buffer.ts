import { MAX_CLIP_MS, MIN_CLIP_MS, TARGET_SAMPLE_RATE, encodeWav, resample, rms } from "@jarvis/voice/audio";

/** Accumulates microphone chunks and produces the WAV the sidecar expects. Pure, so it is testable without a browser. */
export class PcmBuffer {
  private readonly chunks: Float32Array[] = [];
  private length = 0;
  /** RMS of the most recent chunk: a real input level, not an animation. */
  level = 0;

  constructor(readonly sampleRate: number) {}

  get ms(): number {
    return Math.round((this.length / this.sampleRate) * 1000);
  }

  /** True once the clip reached the maximum length; the caller should stop recording. */
  get full(): boolean {
    return this.ms >= MAX_CLIP_MS;
  }

  push(chunk: Float32Array): void {
    if (this.full) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    this.level = rms(chunk);
  }

  /** 16 kHz mono PCM16 WAV, or undefined when the clip is too short to be speech. */
  toWav(): Uint8Array | undefined {
    if (this.ms < MIN_CLIP_MS) return undefined;
    const all = new Float32Array(this.length);
    let o = 0;
    for (const c of this.chunks) (all.set(c, o), (o += c.length));
    return encodeWav(resample({ samples: all, sampleRate: this.sampleRate }, TARGET_SAMPLE_RATE));
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
