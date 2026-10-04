import type { Transcriber, Transcript, TranscribeOptions } from "./transcriber";
import { decodeWav, durationMs } from "./wav";

export interface GroqTranscriberOptions {
  apiKey: string;
  /** whisper-large-v3-turbo (fast) or whisper-large-v3 (most accurate). */
  model?: string;
  /** ISO 639-1 or "auto". */
  language?: string;
  /** Vocabulary/style hint (whisper "prompt", ~224 tokens max). */
  prompt?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** The engine refused because of a quota; `retryAfterMs` says when to try again. */
export class SttRateLimited extends Error {
  constructor(readonly retryAfterMs: number, message: string) {
    super(message);
  }
}

interface VerboseSegment {
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  text?: string;
}

/**
 * Whisper large-v3 hosted by Groq (free tier, OpenAI-compatible endpoint). Audio LEAVES the machine: only used when the user
 * configured it. Segments that whisper itself marks as probably-not-speech are dropped (its classic hallucinations on noise).
 */
export class GroqTranscriber implements Transcriber {
  private readonly f: typeof fetch;
  readonly model: string;

  constructor(private readonly o: GroqTranscriberOptions) {
    this.f = o.fetch ?? fetch;
    this.model = o.model ?? "whisper-large-v3-turbo";
  }

  async transcribe(wav: Uint8Array, { language, signal, prompt }: TranscribeOptions = {}): Promise<Transcript> {
    const lang = language ?? this.o.language ?? "auto";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "clip.wav");
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    if (lang !== "auto") form.append("language", lang);
    const p = prompt ?? this.o.prompt;
    if (p) form.append("prompt", p.slice(0, 800));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 20_000);
    signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const started = Date.now();
    try {
      const res = await this.f(`${this.o.baseUrl ?? "https://api.groq.com/openai/v1"}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.apiKey}` },
        body: form,
        signal: ac.signal,
      });
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        throw new SttRateLimited(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000, "Groq STT rate limited");
      }
      if (!res.ok) throw new Error(`Groq STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { text?: string; language?: string; segments?: VerboseSegment[] };
      const segs = j.segments ?? [];
      // Whisper's own signal for "this is noise, not speech": high no-speech probability AND low token confidence.
      const kept = segs.length ? segs.filter((s) => !((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.8)) : undefined;
      const text = (kept ? kept.map((s) => s.text ?? "").join("") : (j.text ?? "")).replace(/\s+/g, " ").trim();
      const lps = (kept ?? []).map((s) => s.avg_logprob).filter((x): x is number => typeof x === "number");
      return {
        text,
        ...(j.language ? { language: j.language } : lang !== "auto" ? { language: lang } : {}),
        audioMs: durationMs(decodeWav(wav)),
        latencyMs: Date.now() - started,
        engine: `groq:${this.model}`,
        ...(lps.length ? { confidence: Math.exp(lps.reduce((a, b) => a + b, 0) / lps.length) } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Tries engines in order (e.g. Groq, then local whisper). A rate-limited engine is skipped until its retry time; any other
 * failure falls through to the next engine for this call. The transcript says which engine produced it.
 */
export class FallbackTranscriber implements Transcriber {
  private readonly blockedUntil = new Map<number, number>();

  constructor(
    private readonly engines: readonly { name: string; engine: Transcriber }[],
    private readonly opts: { now?: () => number; onFallback?: (from: string, reason: string) => void } = {},
  ) {
    if (engines.length === 0) throw new Error("FallbackTranscriber needs at least one engine");
  }

  async transcribe(wav: Uint8Array, o: TranscribeOptions = {}): Promise<Transcript> {
    const now = this.opts.now ?? Date.now;
    let last: unknown;
    for (let i = 0; i < this.engines.length; i++) {
      const { name, engine } = this.engines[i]!;
      if ((this.blockedUntil.get(i) ?? 0) > now() && i < this.engines.length - 1) continue;
      try {
        const t = await engine.transcribe(wav, o);
        return { ...t, engine: t.engine ?? name };
      } catch (e) {
        if (o.signal?.aborted) throw e;
        last = e;
        if (e instanceof SttRateLimited) this.blockedUntil.set(i, now() + e.retryAfterMs);
        this.opts.onFallback?.(name, e instanceof Error ? e.message : String(e));
      }
    }
    throw last instanceof Error ? last : new Error("all speech engines failed");
  }
}
