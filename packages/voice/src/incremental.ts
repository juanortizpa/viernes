import { prepareClip, VoiceRejected, type Transcriber, type Transcript } from "./transcriber";
import { encodeWav, rms, TARGET_SAMPLE_RATE } from "./wav";

/**
 * Listening while the user is still talking (ADR-0029). Audio arrives in small 16 kHz chunks; partial transcriptions of what has
 * been said so far run in the background, so the assistant can start thinking from the first words. When the user stops, the last
 * partial is reused if it already covered every spoken frame — then the final transcript costs nothing extra.
 */
export interface PartialTranscript {
  text: string;
  confidence?: number;
  /** Audio length the partial was made from. */
  coveredMs: number;
  /** It covered all the speech so far (the user had paused): it is probably the final text. */
  complete: boolean;
  /** Same words as the previous partial. */
  stable: boolean;
}

export interface IncrementalOptions {
  /** Engine for partials (fast, e.g. Groq whisper). Without it there are no partials: `end` simply transcribes everything. */
  partial?: Transcriber;
  /** Full-quality transcription of the whole clip (the race/fallback chain), used when no partial can be reused. */
  final: Transcriber;
  /** Whether a fast transcript can be trusted as is (confidence, or it is a clear local command). */
  accept: (t: Transcript) => boolean;
  onPartial?: (p: PartialTranscript) => void;
  /** Checked before each partial (e.g. a requests-per-minute budget shared with other calls). */
  allowPartial?: () => boolean;
  language?: string;
  /** New audio needed before the next partial while the user keeps talking. */
  everyMs?: number;
  /** Silence after speech that counts as a pause (a partial is taken at once). */
  pauseMs?: number;
  maxPartials?: number;
  maxMs?: number;
}

const FRAME = Math.round(TARGET_SAMPLE_RATE * 0.02); // 20 ms
const norm = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

/** Energy VAD with an adaptive noise floor (frames of 20 ms). Audio time only: no clock, fully deterministic. */
export class SpeechActivity {
  private noise = 0.004;
  private pending: number[] = [];
  speechMs = 0;
  /** Audio time (ms) at the end of the last speech frame; -1 before any speech. */
  lastSpeechEndMs = -1;
  totalMs = 0;

  constructor(private readonly minRms = 0.012) {}

  push(chunk: Float32Array): void {
    for (const x of chunk) this.pending.push(x);
    while (this.pending.length >= FRAME) {
      const f = this.pending.splice(0, FRAME);
      const level = rms(f);
      this.totalMs += 20;
      const speech = level > Math.max(this.minRms, this.noise * 3);
      if (speech) {
        this.speechMs += 20;
        this.lastSpeechEndMs = this.totalMs;
      } else this.noise = 0.95 * this.noise + 0.05 * level; // only quiet frames teach the floor
    }
  }

  /** Silence since the last speech frame (0 while talking; all of it before any speech). */
  get trailingSilenceMs(): number {
    return this.lastSpeechEndMs < 0 ? this.totalMs : this.totalMs - this.lastSpeechEndMs;
  }
}

interface PartialRun {
  coveredMs: number;
  /** Speech end (audio ms) when the partial started: it covers all speech iff no speech came after. */
  speechEndAtStart: number;
  promise: Promise<Transcript | undefined>;
}

export class IncrementalTranscriber {
  private readonly chunks: Float32Array[] = [];
  private samples = 0;
  private readonly vad = new SpeechActivity();
  private inflight: PartialRun | undefined;
  private last: { run: PartialRun; t: Transcript; announcedComplete: boolean } | undefined;
  private partials = 0;
  private lastText = "";
  private readonly ac = new AbortController();
  private ended = false;

  constructor(private readonly o: IncrementalOptions) {}

  get audioMs(): number {
    return Math.round((this.samples / TARGET_SAMPLE_RATE) * 1000);
  }

  push(chunk16k: Float32Array): void {
    if (this.ended) return;
    if (this.audioMs + (chunk16k.length / TARGET_SAMPLE_RATE) * 1000 > (this.o.maxMs ?? 30_000)) return; // over the cap: ignored
    this.chunks.push(chunk16k);
    this.samples += chunk16k.length;
    this.vad.push(chunk16k);
    this.maybePartial();
  }

  private maybePartial(): void {
    if (!this.o.partial || this.inflight || this.ended || this.partials >= (this.o.maxPartials ?? 8)) return;
    if (this.vad.speechMs < 300) return; // nothing worth transcribing yet
    const coveredBefore = this.last?.run.coveredMs ?? 0;
    const newSpeech = this.vad.lastSpeechEndMs > (this.last?.run.speechEndAtStart ?? -1);
    const pausedNow = this.vad.trailingSilenceMs >= (this.o.pauseMs ?? 250);
    // The last partial already heard every spoken frame and now the user paused: it is complete, no new call needed.
    if (pausedNow && !newSpeech && this.last && !this.last.announcedComplete) return this.announce(this.last, true);
    const paused = pausedNow && newSpeech;
    const enoughNew = this.audioMs - coveredBefore >= (this.o.everyMs ?? 700) && newSpeech;
    if (!paused && !enoughNew) return;
    if (this.o.allowPartial && !this.o.allowPartial()) return;
    this.startPartial();
  }

  private startPartial(): PartialRun {
    const coveredMs = this.audioMs;
    const speechEndAtStart = this.vad.lastSpeechEndMs;
    this.partials++;
    const run: PartialRun = { coveredMs, speechEndAtStart, promise: Promise.resolve(undefined) };
    run.promise = (async () => {
      try {
        const clip = prepareClip(encodeWav({ samples: this.audio(), sampleRate: TARGET_SAMPLE_RATE }));
        const t = await this.o.partial!.transcribe(clip.wav, { ...(this.o.language ? { language: this.o.language } : {}), signal: this.ac.signal });
        if (!t.text) return undefined;
        const stable = norm(t.text) === norm(this.lastText);
        this.lastText = t.text;
        if (!this.last || this.last.run.coveredMs <= coveredMs) this.last = { run, t, announcedComplete: false };
        // Complete = it covers every spoken frame AND the user is pausing now (judged when the result arrives, not when it started).
        const complete = run.speechEndAtStart >= this.vad.lastSpeechEndMs && this.vad.trailingSilenceMs >= (this.o.pauseMs ?? 250);
        if (this.last.run === run) this.announce(this.last, complete, stable);
        return t;
      } catch {
        return undefined; // a failed partial only costs the head start
      } finally {
        if (this.inflight === run) this.inflight = undefined;
        if (!this.ended) this.maybePartial();
      }
    })();
    this.inflight = run;
    return run;
  }

  private announce(last: { run: PartialRun; t: Transcript; announcedComplete: boolean }, complete: boolean, stable = true): void {
    if (this.ended) return;
    if (complete) last.announcedComplete = true;
    const t = last.t;
    this.o.onPartial?.({ text: t.text, ...(t.confidence !== undefined ? { confidence: t.confidence } : {}), coveredMs: last.run.coveredMs, complete, stable });
  }

  private audio(): Float32Array {
    const out = new Float32Array(this.samples);
    let o = 0;
    for (const c of this.chunks) out.set(c, o), (o += c.length);
    return out;
  }

  /**
   * The user stopped. Reuse a partial that started after the last spoken frame (it heard everything) when its text can be trusted;
   * otherwise transcribe the whole clip with the full chain. `source` says which, for the latency metrics.
   */
  async end(signal?: AbortSignal): Promise<{ transcript: Transcript; source: "partial" | "final" }> {
    this.ended = true;
    signal?.addEventListener("abort", () => this.ac.abort(), { once: true });
    if (this.vad.speechMs < 150) {
      this.ac.abort();
      throw new VoiceRejected("silence", "No se escuchó nada");
    }
    const speechEnd = this.vad.lastSpeechEndMs;
    const covering = [this.inflight, this.last?.run].filter((r): r is PartialRun => r !== undefined && r.speechEndAtStart >= speechEnd);
    for (const run of covering) {
      const t = await run.promise;
      if (t?.text && this.o.accept(t)) return { transcript: t, source: "partial" };
    }
    const clip = prepareClip(encodeWav({ samples: this.audio(), sampleRate: TARGET_SAMPLE_RATE }));
    const t = await this.o.final.transcribe(clip.wav, { ...(this.o.language ? { language: this.o.language } : {}), ...(signal ? { signal } : {}) });
    return { transcript: t, source: "final" };
  }

  cancel(): void {
    this.ended = true;
    this.ac.abort();
  }
}
