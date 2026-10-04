import { decodeWav, durationMs, hasSpeech, normalizeLoudness, padSilence, resample, TARGET_SAMPLE_RATE, encodeWav, type PcmAudio } from "./wav";

export const MIN_CLIP_MS = 300;
/** Push-to-talk clips are short; the cap also keeps one IPC line under its size limit. */
export const MAX_CLIP_MS = 20_000;

export interface Transcript {
  text: string;
  /** ISO code when the engine reports one. */
  language?: string;
  /** Length of the audio. */
  audioMs: number;
  /** Time spent transcribing. */
  latencyMs: number;
}

export interface TranscribeOptions {
  /** ISO 639-1 code, or "auto". */
  language?: string;
  signal?: AbortSignal;
}

/** A speech-to-text engine. Receives a 16 kHz mono PCM16 WAV that already passed `prepareClip`. */
export interface Transcriber {
  transcribe(wav: Uint8Array, opts?: TranscribeOptions): Promise<Transcript>;
}

export type RejectReason = "invalid" | "too_short" | "too_long" | "silence";

/** The clip is unusable; the message is safe to show the user. */
export class VoiceRejected extends Error {
  constructor(readonly reason: RejectReason, message: string) {
    super(message);
  }
}

/** Validate and normalise a clip before any engine sees it: decode, length limits, 16 kHz mono, silence gate. */
export function prepareClip(wav: Uint8Array): { wav: Uint8Array; audio: PcmAudio; audioMs: number } {
  let audio: PcmAudio;
  try {
    audio = decodeWav(wav);
  } catch (e) {
    throw new VoiceRejected("invalid", e instanceof Error ? e.message : "invalid audio");
  }
  const ms = durationMs(audio);
  if (ms < MIN_CLIP_MS) throw new VoiceRejected("too_short", "El audio es demasiado corto");
  if (ms > MAX_CLIP_MS) throw new VoiceRejected("too_long", `El audio supera ${MAX_CLIP_MS / 1000} s`);
  if (!hasSpeech(audio)) throw new VoiceRejected("silence", "No se detectó voz");
  // 16 kHz (anti-aliased), levelled, with a little silence around it: what the recogniser does best with.
  const norm = padSilence(normalizeLoudness(resample(audio, TARGET_SAMPLE_RATE)));
  return { wav: encodeWav(norm), audio: norm, audioMs: ms };
}

/** Deterministic engine for tests and development. Not speech recognition. */
export class FakeTranscriber implements Transcriber {
  readonly calls: Uint8Array[] = [];
  constructor(private readonly respond: string | ((wav: Uint8Array) => string) = "hola") {}
  async transcribe(wav: Uint8Array): Promise<Transcript> {
    this.calls.push(wav);
    const text = typeof this.respond === "string" ? this.respond : this.respond(wav);
    return { text, audioMs: durationMs(decodeWav(wav)), latencyMs: 0 };
  }
}
