import { SttRateLimited } from "./groq-stt";
import type { Transcriber, Transcript, TranscribeOptions } from "./transcriber";
import { decodeWav, durationMs } from "./wav";

export interface GeminiTranscriberOptions {
  apiKey: string;
  /** A fast multimodal model. Measured (ADR-0020): gemini-3.5-flash-lite ~0.9 s; 3.1-flash-lite varied 1.5-19 s. */
  model?: string;
  /** App/command names to prefer when a word sounds like one. */
  vocabulary?: readonly string[];
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const instruction = (vocab: readonly string[]): string =>
  `You are the speech-recognition stage of a voice assistant called Jarvis. Users speak Rioplatense Spanish (voseo) or English, often fast or hesitating.
1) "heard": transcribe exactly what was said, in the language spoken.
2) "meant": the request the user most likely intended, in the same language: fix obvious misrecognitions and drop fillers/stutters ("eh", repeated words).${vocab.length ? ` Prefer these app names when a word sounds like one: ${vocab.join(", ")}.` : ""} Do not add anything that was not said; if the audio is clear, "meant" equals "heard". If there is no speech, both are "".`;

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** Google's 429 body carries a RetryInfo like {"retryDelay": "17s"}. */
function retryDelayMs(body: unknown): number {
  const details = (body as { error?: { details?: { retryDelay?: string }[] } })?.error?.details ?? [];
  for (const d of details) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay ?? "");
    if (m) return Math.ceil(Number(m[1]) * 1000);
  }
  return 60_000;
}

/**
 * Transcription by a multimodal LLM (Gemini, free tier): in ONE call it returns what was said and what was meant, which is how
 * "understand me even if I say it badly" is done. Audio LEAVES the machine. `text` is the interpretation; `heard` the literal.
 * Safety: an interpretation that adds more than 3 words to what was heard is not trusted (the literal is used instead).
 */
export class GeminiTranscriber implements Transcriber {
  private readonly f: typeof fetch;
  readonly model: string;

  constructor(private readonly o: GeminiTranscriberOptions) {
    this.f = o.fetch ?? fetch;
    this.model = o.model ?? "gemini-3.5-flash-lite";
  }

  async transcribe(wav: Uint8Array, { signal }: TranscribeOptions = {}): Promise<Transcript> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 20_000);
    signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const started = Date.now();
    try {
      const res = await this.f(`${this.o.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"}/models/${this.model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": this.o.apiKey, "content-type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instruction(this.o.vocabulary ?? []) }] },
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: Buffer.from(wav).toString("base64") } }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: { type: "OBJECT", properties: { heard: { type: "STRING" }, meant: { type: "STRING" } }, required: ["heard", "meant"] },
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as unknown;
      if (res.status === 429) throw new SttRateLimited(retryDelayMs(body), "Gemini STT rate limited");
      if (!res.ok) throw new Error(`Gemini STT HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      const raw = ((body as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      let heard = "";
      let meant = "";
      try {
        const o = JSON.parse(raw) as { heard?: unknown; meant?: unknown };
        heard = typeof o.heard === "string" ? o.heard.trim() : "";
        meant = typeof o.meant === "string" ? o.meant.trim() : "";
      } catch {
        throw new Error("Gemini STT returned something that is not the expected JSON");
      }
      const trusted = meant && words(meant) <= words(heard) + 3 ? meant : heard;
      return {
        text: trusted,
        ...(trusted !== heard ? { heard } : {}),
        audioMs: durationMs(decodeWav(wav)),
        latencyMs: Date.now() - started,
        engine: `gemini:${this.model}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
