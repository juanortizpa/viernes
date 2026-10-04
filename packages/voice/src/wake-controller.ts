import { Endpointer, type EndpointerOptions } from "./endpointer";
import { TemplateSpotter, type Enrollment } from "./spotter";
import { encodeWav, TARGET_SAMPLE_RATE } from "./wav";

/**
 * The listening loop: stage 1 (cheap spotter) -> stage 2 (transcription verifies "jarvis") -> command -> keep listening
 * for a follow-up window so the wake word need not be repeated. Pure: audio and events in, actions out; time comes from `now`.
 *
 *  off ──start──> idle ──(utterance that stage 1 liked)──> verifying ──not the wake word──> idle
 *                                                              │ wake word, nothing after it
 *                                                              ▼
 *                                                           command ──utterance──> busy ──task done──> followUp ──10 s of silence──> idle
 *                                                              ▲   wake word + command in one breath: server runs it ──> busy      │ utterance
 *                                                              └──────────────────────────────────────────────────────────────────┘ (no wake word needed)
 */

export type WakeState = "off" | "idle" | "verifying" | "command" | "busy" | "followUp";

export type WakeAction =
  | { type: "state"; state: WakeState; /** follow-up: ms left, for a real countdown. */ followUpMs?: number }
  /** Stage 2: send this utterance to be transcribed and checked for the wake word. */
  | { type: "verify"; wav: Uint8Array }
  /** A command utterance (after the wake word, or inside the follow-up window). */
  | { type: "command"; wav: Uint8Array; source: "wake" | "followUp"; /** Silence that closed the turn: the user stopped talking this long ago. */ endSilenceMs: number }
  | { type: "discard"; reason: "not-for-me" | "timeout" | "too-long" };

export interface WakeControllerOptions {
  /** User's enrolled wake-word recordings. Without them stage 1 is plain voice-activity ("vad" mode: every utterance is verified). */
  enrollment?: Enrollment;
  sensitivity?: number;
  /** After a voice task finishes (and its answer was spoken), how long to keep listening without the wake word. */
  followUpMs?: number;
  /** After the wake word alone, how long to wait for the user to start the command. */
  commandWaitMs?: number;
  /** Silence that ends a command/follow-up utterance. Longer than for the wake word, so a thinking pause does not split a sentence. */
  commandEndSilenceMs?: number;
  /** Safety valves. */
  verifyTimeoutMs?: number;
  busyTimeoutMs?: number;
  endpointer?: EndpointerOptions;
  now?: () => number;
}

export class WakeController {
  state: WakeState = "off";
  private readonly spotter: TemplateSpotter | undefined;
  private readonly ep: Endpointer;
  private readonly now: () => number;
  private readonly commandEnd: number;
  private readonly o: Required<Pick<WakeControllerOptions, "followUpMs" | "commandWaitMs" | "verifyTimeoutMs" | "busyTimeoutMs">>;
  private firedAtMs = -Infinity;
  private deadline = 0;
  private speaking = false;
  private followUpPending = false;
  private lastCountdown = 0;
  private counters = { verified: 0, notForMe: 0 };
  /** A command spoken while the wake word was still being verified (the user does not wait for us). */
  private pending: Uint8Array | undefined;
  /**
   * Semantic end of turn (ADR-0029): the sidecar heard every word and the sentence sounds finished, so the turn may close after a
   * short silence instead of the patient default. Valid only while the user stays silent: any new voiced frame cancels it.
   */
  private early: { endMs: number; voicedAt: number } | undefined;

  constructor(private readonly opts: WakeControllerOptions = {}) {
    this.spotter = opts.enrollment ? new TemplateSpotter(opts.enrollment, { sensitivity: opts.sensitivity }) : undefined;
    this.ep = new Endpointer({ endSilenceMs: 600, maxMs: 10_000, ...opts.endpointer });
    this.now = opts.now ?? Date.now;
    this.commandEnd = opts.commandEndSilenceMs ?? 900;
    this.o = { followUpMs: opts.followUpMs ?? 10_000, commandWaitMs: opts.commandWaitMs ?? 6_000, verifyTimeoutMs: opts.verifyTimeoutMs ?? 20_000, busyTimeoutMs: opts.busyTimeoutMs ?? 90_000 };
  }

  /** Stage 1 is the template spotter when the user enrolled their voice, otherwise plain voice activity. */
  get stage1(): "template" | "vad" {
    return this.spotter ? "template" : "vad";
  }

  /** What stage 1 is seeing, for a calibration readout: lower score = closer to the user's wake word; it fires at or below `threshold`. */
  diagnostics(): { stage1: "template" | "vad"; bestScore: number | undefined; threshold: number | undefined; verified: number; notForMe: number } {
    const best = this.spotter?.bestRecentScore;
    return { stage1: this.stage1, bestScore: best !== undefined && Number.isFinite(best) ? best : undefined, threshold: this.spotter?.threshold, ...this.counters };
  }

  start(): WakeAction[] {
    return this.goto("idle");
  }

  stop(): WakeAction[] {
    return this.goto("off");
  }

  /** The transcript so far covers everything said and reads as a finished sentence: close the command turn after `ms` of silence. */
  hintTurnComplete(ms = 450): void {
    if (this.state !== "command" && this.state !== "followUp") return;
    if (!this.ep.inSpeech) return;
    this.early = { endMs: ms, voicedAt: this.ep.voicedMs };
  }

  private goto(state: WakeState, extra: { followUpMs?: number } = {}): WakeAction[] {
    this.state = state;
    this.pending = undefined;
    this.early = undefined;
    this.ep.reset();
    this.spotter?.reset();
    this.firedAtMs = -Infinity;
    return [{ type: "state", state, ...extra }];
  }

  /** Feed 16 kHz mono audio (any chunk size). */
  onAudio(chunk: Float32Array): WakeAction[] {
    const actions = this.tick();
    if (this.speaking || this.state === "off" || this.state === "busy") return actions;
    // Keep listening WHILE the wake word is being verified: people do not wait for the assistant before giving the command.
    if (this.early && this.ep.voicedMs > this.early.voicedAt) this.early = undefined; // the user went on talking
    const endSilence = this.state === "idle" ? (this.opts.endpointer?.endSilenceMs ?? 600) : (this.early?.endMs ?? this.commandEnd);
    this.ep.setEndSilence(endSilence);
    const before = this.ep.elapsedMs;
    this.ep.push(chunk);
    if (this.early && this.ep.voicedMs > this.early.voicedAt && this.ep.state !== "ended") {
      this.early = undefined; // speech resumed inside this chunk: be patient again
      this.ep.setEndSilence(this.commandEnd);
    }
    if (this.state === "idle" && this.spotter) {
      for (const r of this.spotter.push(chunk)) if (r.fired) this.firedAtMs = before + (chunk.length / TARGET_SAMPLE_RATE) * 1000;
    }

    if (this.ep.state !== "ended") return actions;
    const samples = this.ep.take();
    const startedAt = this.ep.utteranceStartMs ?? 0;
    const closedAfterMs = this.ep.trailingSilenceMs;
    this.early = undefined;
    const liked = this.stage1 === "vad" || this.firedAtMs >= startedAt - 200;
    this.ep.reset();
    this.spotter?.reset();
    this.firedAtMs = -Infinity;
    if (!samples || samples.length < TARGET_SAMPLE_RATE * 0.25) return actions;
    const wav = encodeWav({ samples, sampleRate: TARGET_SAMPLE_RATE });

    if (this.state === "verifying") {
      this.pending = wav; // hold it until the verdict arrives
      return actions;
    }
    if (this.state === "idle") {
      if (!liked) {
        this.counters.notForMe++;
        return [...actions, { type: "discard", reason: "not-for-me" }];
      }
      this.counters.verified++;
      this.deadline = this.now() + this.o.verifyTimeoutMs;
      this.state = "verifying";
      return [...actions, { type: "state", state: "verifying" }, { type: "verify", wav }];
    }
    if (this.state === "command" || this.state === "followUp") {
      const source = this.state === "command" ? "wake" : "followUp";
      this.deadline = this.now() + this.o.busyTimeoutMs;
      this.state = "busy";
      return [...actions, { type: "state", state: "busy" }, { type: "command", wav, source, endSilenceMs: closedAfterMs }];
    }
    return actions;
  }

  /** The sidecar's answer to `verify`. `commandRan`: the utterance also contained the command and the sidecar already ran it. */
  onVerified(r: { detected: boolean; commandRan: boolean }): WakeAction[] {
    if (this.state !== "verifying") return [];
    const pending = this.pending;
    this.pending = undefined;
    if (!r.detected) return this.goto("idle");
    if (r.commandRan) {
      this.deadline = this.now() + this.o.busyTimeoutMs;
      return this.goto("busy");
    }
    if (pending) {
      // The command was already spoken while we verified: send it now.
      this.deadline = this.now() + this.o.busyTimeoutMs;
      return [...this.goto("busy"), { type: "command", wav: pending, source: "wake", endSilenceMs: this.commandEnd }];
    }
    this.deadline = this.now() + this.o.commandWaitMs;
    if (this.ep.inSpeech) {
      // Mid-command right now: keep what has been captured and carry on to the end of the sentence.
      this.state = "command";
      return [{ type: "state", state: "command" }];
    }
    return this.goto("command");
  }

  /** A task started by any means (typing, push-to-talk, the wake word). Stops listening for a new command until it ends. */
  onTaskStarted(): WakeAction[] {
    if (this.state === "off" || this.state === "busy") return [];
    this.deadline = this.now() + this.o.busyTimeoutMs;
    return this.goto("busy");
  }

  /** The task ended. The follow-up window opens only after a VOICE task (a typed one does not turn the microphone back on). */
  onTaskDone(opts: { fromVoice: boolean }): WakeAction[] {
    if (this.state === "off") return [];
    if (!opts.fromVoice) return this.goto("idle");
    if (this.speaking) {
      this.followUpPending = true; // the window starts when the answer has been spoken
      return [];
    }
    return this.openFollowUp();
  }

  /** The assistant started/stopped talking. Its own voice must not be heard as a command, so audio is dropped meanwhile. */
  onSpeaking(speaking: boolean): WakeAction[] {
    this.speaking = speaking;
    if (this.state === "off") return [];
    this.ep.reset();
    this.spotter?.reset();
    if (!speaking && this.followUpPending) {
      this.followUpPending = false;
      return this.openFollowUp();
    }
    return [];
  }

  private openFollowUp(): WakeAction[] {
    this.deadline = this.now() + this.o.followUpMs;
    this.lastCountdown = this.now();
    return this.goto("followUp", { followUpMs: this.o.followUpMs });
  }

  /** Timers; also called from `onAudio`. Call it on a timer too when audio is not flowing. */
  tick(): WakeAction[] {
    const t = this.now();
    switch (this.state) {
      case "verifying":
      case "busy":
        if (t >= this.deadline) return this.goto("idle");
        return [];
      case "command":
        if (!this.ep.inSpeech && t >= this.deadline) return [...this.goto("idle"), { type: "discard", reason: "timeout" }];
        return [];
      case "followUp": {
        if (this.speaking) return [];
        if (!this.ep.inSpeech && t >= this.deadline) return this.goto("idle");
        if (this.ep.inSpeech) this.deadline = Math.max(this.deadline, t + 1_000); // never cut someone off mid-sentence
        if (t - this.lastCountdown >= 500) {
          this.lastCountdown = t;
          return [{ type: "state", state: "followUp", followUpMs: Math.max(0, this.deadline - t) }];
        }
        return [];
      }
      default:
        return [];
    }
  }
}
