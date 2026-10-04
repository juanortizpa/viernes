import type { Transcriber, Transcript, TranscribeOptions } from "./transcriber";

export interface RaceTranscriberOptions {
  /** Quick literal engine (e.g. Groq whisper turbo, ~0.5 s). */
  fast: Transcriber;
  /** Slower engine that understands what was meant (e.g. Gemini, ~1.4 s). */
  accurate: Transcriber;
  /**
   * True when the fast text is already unambiguous enough to act on (e.g. it resolves to a deterministic local command), so
   * waiting for the accurate engine would only add latency.
   */
  acceptFast: (text: string) => boolean;
  /** Give up waiting for the accurate engine after this long and use the fast text. */
  accurateTimeoutMs?: number;
}

/**
 * Both engines start together. Fast path: if the fast transcript is a clear command, return it immediately. Otherwise return
 * the accurate engine's interpretation; if that fails or is too slow, fall back to the fast text. If the fast engine fails,
 * the accurate one is awaited. Fails only when both fail.
 */
export class RaceTranscriber implements Transcriber {
  constructor(private readonly o: RaceTranscriberOptions) {}

  async transcribe(wav: Uint8Array, opts: TranscribeOptions = {}): Promise<Transcript> {
    // Only the accurate engine gets its own controller: it is the one cancelled when the fast path wins.
    const ac = new AbortController();
    opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const accurate = this.o.accurate.transcribe(wav, { ...opts, signal: ac.signal }).then(
      (t) => ({ ok: true as const, t }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    let fast: Transcript | undefined;
    let fastError: unknown;
    try {
      fast = await this.o.fast.transcribe(wav, opts);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      fastError = e;
    }
    if (fast && fast.text && this.o.acceptFast(fast.text)) {
      ac.abort(); // the accurate answer is no longer needed
      return fast;
    }
    const timeout = new Promise<{ ok: false; e: Error }>((r) => setTimeout(() => r({ ok: false, e: new Error("accurate engine too slow") }), this.o.accurateTimeoutMs ?? 4_000));
    const acc = await Promise.race([accurate, timeout]);
    if (acc.ok && (acc.t.text || !fast)) return acc.t;
    if (fast) return fast;
    throw acc.ok ? new Error("no transcript") : fastError instanceof Error ? fastError : (acc.e as Error);
  }
}
