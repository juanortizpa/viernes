import { toBase64 } from "./pcm-buffer";

/** ~200 ms of 16 kHz audio per message: small enough to keep the sidecar close behind the voice, few enough messages to be cheap. */
const CHUNK_SAMPLES = 3200;

export type StreamSend = (msg: { type: "voice.stream.start"; id: string } | { type: "voice.stream.chunk"; id: string; pcm: string } | { type: "voice.stream.end"; id: string } | { type: "voice.stream.cancel"; id: string }) => void;

/**
 * Sends the microphone to the sidecar WHILE the user talks (ADR-0029), so transcription and thinking start from the first words.
 * Takes 16 kHz Float32 chunks of any size, sends PCM16 in ~200 ms pieces, flushes the remainder on `end`. Pure: no browser APIs.
 */
export class VoiceStream {
  private pending: Float32Array[] = [];
  private pendingLength = 0;
  private closed = false;
  /** Audio sent so far, ms. */
  sentMs = 0;

  constructor(
    private readonly send: StreamSend,
    readonly id: string = Math.random().toString(36).slice(2, 12),
  ) {
    send({ type: "voice.stream.start", id: this.id });
  }

  push(chunk16k: Float32Array): void {
    if (this.closed || chunk16k.length === 0) return;
    this.pending.push(chunk16k);
    this.pendingLength += chunk16k.length;
    if (this.pendingLength >= CHUNK_SAMPLES) this.flush();
  }

  /** The user stopped: send what is left and close. */
  end(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.send({ type: "voice.stream.end", id: this.id });
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.send({ type: "voice.stream.cancel", id: this.id });
  }

  private flush(): void {
    if (this.pendingLength === 0) return;
    const pcm = new Uint8Array(this.pendingLength * 2);
    const view = new DataView(pcm.buffer);
    let o = 0;
    for (const c of this.pending) for (const x of c) view.setInt16((o++) * 2, Math.max(-32768, Math.min(32767, Math.round(x * 32767))), true);
    this.sentMs += (this.pendingLength / 16_000) * 1000;
    this.pending = [];
    this.pendingLength = 0;
    this.send({ type: "voice.stream.chunk", id: this.id, pcm: toBase64(pcm) });
  }
}
