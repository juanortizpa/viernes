import { rms, TARGET_SAMPLE_RATE } from "./wav";

export interface EndpointerOptions {
  /** Speech must last this long to count (shorter is a click or cough). */
  minSpeechMs?: number;
  /** This much silence after speech ends the utterance. */
  endSilenceMs?: number;
  /** Hard cap on one utterance. */
  maxMs?: number;
  /** Audio kept from BEFORE speech was detected, so the first syllable is not lost. */
  preRollMs?: number;
  /** Absolute RMS floor for "speech". The effective threshold also adapts to the room's noise. */
  minRms?: number;
}

export type EndpointState = "silence" | "speech" | "ended";

const FRAME_MS = 20;

/**
 * Energy endpointer with an adaptive noise floor. Feed 16 kHz chunks; it tells you when speech started and when the
 * utterance ended, and hands back the audio (with pre-roll) once it has. Pure and clock-free: time is audio time.
 */
export class Endpointer {
  private readonly frame = Math.round((TARGET_SAMPLE_RATE * FRAME_MS) / 1000);
  private readonly o: Required<EndpointerOptions>;
  private pending: number[] = [];
  private preRoll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private noise = 0.004;
  private speechMs = 0;
  private silenceMs = 0;
  private totalMs = 0;
  private speaking = false;
  state: EndpointState = "silence";
  /** Audio time since the last `reset`, ms. */
  elapsedMs = 0;
  /** Audio time at which the current utterance began (including pre-roll); undefined before speech. */
  utteranceStartMs: number | undefined;

  constructor(opts: EndpointerOptions = {}) {
    this.o = { minSpeechMs: 250, endSilenceMs: 700, maxMs: 20_000, preRollMs: 300, minRms: 0.012, ...opts };
  }

  reset(): void {
    this.pending = [];
    this.preRoll = [];
    this.utterance = [];
    this.speechMs = this.silenceMs = this.totalMs = this.elapsedMs = 0;
    this.speaking = false;
    this.utteranceStartMs = undefined;
    this.state = "silence";
  }

  /** Change how much silence ends an utterance (e.g. be more patient while a command is being dictated). */
  setEndSilence(ms: number): void {
    this.o.endSilenceMs = ms;
  }

  /** True once speech has begun in the current utterance. */
  get inSpeech(): boolean {
    return this.speaking;
  }

  push(chunk: Float32Array): EndpointState {
    if (this.state === "ended") return this.state;
    for (const x of chunk) this.pending.push(x);
    while (this.pending.length >= this.frame && (this.state as EndpointState) !== "ended") {
      const f = Float32Array.from(this.pending.splice(0, this.frame));
      this.step(f);
    }
    return this.state;
  }

  private step(f: Float32Array): void {
    this.elapsedMs += FRAME_MS;
    const e = rms(f);
    const threshold = Math.max(this.o.minRms, this.noise * 3);
    const voiced = e >= threshold;
    if (!voiced && !this.speaking) this.noise = this.noise * 0.95 + e * 0.05; // learn the room while nobody talks

    if (!this.speaking) {
      this.preRoll.push(f);
      const keep = Math.ceil(this.o.preRollMs / FRAME_MS);
      if (this.preRoll.length > keep) this.preRoll.shift();
      this.speechMs = voiced ? this.speechMs + FRAME_MS : 0;
      if (this.speechMs >= this.o.minSpeechMs) {
        this.speaking = true;
        this.state = "speech";
        this.utterance = [...this.preRoll];
        this.utteranceStartMs = this.elapsedMs - this.preRoll.length * FRAME_MS;
        this.totalMs = this.utterance.length * FRAME_MS;
        this.silenceMs = 0;
      }
      return;
    }
    this.utterance.push(f);
    this.totalMs += FRAME_MS;
    this.silenceMs = voiced ? 0 : this.silenceMs + FRAME_MS;
    if (this.silenceMs >= this.o.endSilenceMs || this.totalMs >= this.o.maxMs) this.state = "ended";
  }

  /** The finished utterance (pre-roll included, trailing silence trimmed to 200 ms). Undefined until `ended`. */
  take(): Float32Array | undefined {
    if (this.state !== "ended") return undefined;
    const frames = this.utterance.slice(0, this.utterance.length - Math.max(0, Math.floor((this.silenceMs - 200) / FRAME_MS)));
    const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of frames) (out.set(f, o), (o += f.length));
    return out;
  }
}
