import { pickVoice, type VoiceInfo } from "./voices";
import type { Lang } from "./text";

/** The slice of the browser's SpeechSynthesis the controller needs (so it can be tested with a fake). */
export interface SynthLike {
  speak(u: UtteranceLike): void;
  cancel(): void;
  getVoices(): (VoiceInfo & { voiceURI?: string })[];
}
export interface UtteranceLike {
  text: string;
  lang: string;
  rate: number;
  voice: unknown;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}

export interface SpeechEvents {
  /** Audio actually started. `latencyMs` = time since `speak` was requested for that utterance. */
  onStart?: (latencyMs: number, text: string) => void;
  /** Nothing is playing or queued any more. */
  onIdle?: () => void;
  /** Spanish/English text but no installed voice for it. */
  onNoVoice?: (lang: Lang) => void;
}

/**
 * Speaks short utterances in order, so an acknowledgement is never cut off by the answer that follows it, and anything
 * can be interrupted at once (`cancel`) when the user starts talking or presses Esc. `speaking` reflects what the
 * synthesiser reports, not what was requested.
 */
export class SpeechController {
  private queue: { text: string; lang: Lang; requestedAt: number }[] = [];
  private current: UtteranceLike | undefined;
  private generation = 0;
  speaking = false;
  /** Latency of the most recent utterance that started, for the time-to-first-audio metric. */
  lastLatencyMs: number | undefined;

  constructor(
    private readonly synth: SynthLike,
    private readonly makeUtterance: (text: string) => UtteranceLike,
    private readonly events: SpeechEvents = {},
    private readonly opts: { rate?: number; voiceName?: string; now?: () => number } = {},
  ) {}

  speak(text: string, lang: Lang): void {
    if (!text.trim()) return;
    this.queue.push({ text, lang, requestedAt: (this.opts.now ?? Date.now)() });
    if (!this.current) this.next();
  }

  /** Stop right now and forget the queue. */
  cancel(): void {
    this.generation++; // late callbacks from the cancelled utterance must not advance the queue
    this.queue = [];
    this.current = undefined;
    const was = this.speaking;
    this.speaking = false;
    this.synth.cancel();
    if (was) this.events.onIdle?.();
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      if (this.speaking) {
        this.speaking = false;
        this.events.onIdle?.();
      }
      return;
    }
    const voice = pickVoice(this.synth.getVoices(), item.lang, this.opts.voiceName);
    if (!voice) {
      this.events.onNoVoice?.(item.lang);
      return this.next();
    }
    const gen = this.generation;
    const u = this.makeUtterance(item.text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = this.opts.rate ?? 1.05;
    const done = (): void => {
      if (gen !== this.generation) return;
      this.current = undefined;
      this.next();
    };
    u.onstart = () => {
      if (gen !== this.generation) return;
      this.speaking = true;
      this.lastLatencyMs = (this.opts.now ?? Date.now)() - item.requestedAt;
      this.events.onStart?.(this.lastLatencyMs, item.text);
    };
    u.onend = done;
    u.onerror = done; // "interrupted"/"canceled" arrive here too; either way move on
    this.current = u;
    this.synth.speak(u);
  }
}
