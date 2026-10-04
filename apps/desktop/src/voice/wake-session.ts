import { WakeController, enrollmentFromJson, type Enrollment, type WakeAction, type WakeState } from "@jarvis/voice/audio";
import type { LiveClient } from "../live/client";
import { startContinuousMic, type ContinuousMic } from "./mic";
import { toBase64 } from "./pcm-buffer";
import type { VoiceStream } from "./voice-stream";

export const WAKE_ENROLLMENT_KEY = "jarvis.wakeEnrollment";
export const WAKE_SENSITIVITY_KEY = "jarvis.wakeSensitivity";

/** >1 widens the stage-1 threshold (more permissive: fewer misses, more verifications). */
export function loadSensitivity(): number {
  try {
    const v = Number(localStorage.getItem(WAKE_SENSITIVITY_KEY));
    return Number.isFinite(v) && v >= 0.8 && v <= 2.5 ? v : 1.3;
  } catch {
    return 1.3;
  }
}

export function loadEnrollment(): Enrollment | undefined {
  try {
    const raw = localStorage.getItem(WAKE_ENROLLMENT_KEY);
    return raw ? enrollmentFromJson(raw) : undefined;
  } catch {
    return undefined;
  }
}

export interface WakeSessionEvents {
  onState: (state: WakeState, followUpMs?: number) => void;
  onLevel?: (level: number) => void;
  onError: (message: string) => void;
  /** A command utterance ended and was handed to the sidecar; the user stopped talking `endSilenceMs` ago. */
  onCommandSent?: (endSilenceMs: number) => void;
}

/**
 * Glue between the always-on microphone, the pure WakeController and the sidecar. Audio stays in this tab's memory:
 * only an utterance the on-device stage-1 spotter liked is sent (for transcription and the wake-word check), and only a
 * command utterance after that. The user can stop it any time, which closes the microphone.
 */
export class WakeSession {
  private mic: ContinuousMic | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private paused = false;
  private readonly controller: WakeController;
  private offResult: (() => void) | undefined;
  private offPartial: (() => void) | undefined;
  private state: WakeState = "off";
  /** Streaming of the command phase (ADR-0029): the sidecar hears the order while it is being said. */
  private stream: VoiceStream | undefined;

  constructor(private readonly live: LiveClient, private readonly events: WakeSessionEvents, enrollment: Enrollment | undefined = loadEnrollment(), sensitivity: number = loadSensitivity()) {
    this.controller = new WakeController({ enrollment, sensitivity });
  }

  get stage1(): "template" | "vad" {
    return this.controller.stage1;
  }

  diagnostics() {
    return this.controller.diagnostics();
  }

  get running(): boolean {
    return this.mic !== undefined;
  }

  async start(): Promise<void> {
    if (this.mic) return;
    this.offResult = this.live.onWakeResult((r) => this.run(this.controller.onVerified({ detected: r.detected, commandRan: r.commandRan })));
    // Semantic end of turn: when the sidecar says the order is complete, do not wait the full patient silence.
    this.offPartial = this.live.onVoice((n) => n.kind === "partial" && n.turnEnd && this.stream && this.controller.hintTurnComplete());
    try {
      this.mic = await startContinuousMic(
        (chunk) => {
          if (this.paused) return;
          if ((this.state === "command" || this.state === "followUp") && this.live.status === "ready" && this.live.info?.streaming) {
            this.stream ??= this.live.openVoiceStream();
            this.stream.push(chunk);
          }
          this.run(this.controller.onAudio(chunk));
        },
        this.events.onLevel,
      );
    } catch (e) {
      this.offResult();
      this.offResult = undefined;
      this.events.onError(e instanceof Error ? e.message : "No se pudo abrir el micrófono");
      return;
    }
    this.run(this.controller.start());
    this.timer = setInterval(() => this.run(this.controller.tick()), 250);
  }

  private dropStream(): void {
    this.stream?.cancel();
    this.stream = undefined;
  }

  async stop(): Promise<void> {
    this.dropStream();
    clearInterval(this.timer);
    this.timer = undefined;
    this.offResult?.();
    this.offResult = undefined;
    this.offPartial?.();
    this.offPartial = undefined;
    this.run(this.controller.stop());
    const mic = this.mic;
    this.mic = undefined;
    await mic?.stop();
  }

  /** Push-to-talk owns the microphone while held: do not also treat that speech as a wake attempt. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  onTaskStarted(): void {
    this.run(this.controller.onTaskStarted());
  }
  onTaskDone(fromVoice: boolean): void {
    this.run(this.controller.onTaskDone({ fromVoice }));
  }
  onSpeaking(speaking: boolean): void {
    this.run(this.controller.onSpeaking(speaking));
  }

  private run(actions: WakeAction[]): void {
    for (const a of actions) {
      switch (a.type) {
        case "state":
          this.state = a.state;
          // Left the command phase without a command (timeout, stop): nothing is to be answered.
          if (a.state !== "command" && a.state !== "followUp" && a.state !== "busy") this.dropStream();
          this.events.onState(a.state, a.followUpMs);
          break;
        case "verify":
          if (this.live.status === "ready") this.live.verifyWake(toBase64(a.wav));
          else this.run(this.controller.onVerified({ detected: false, commandRan: false }));
          break;
        case "command":
          if (this.live.status !== "ready") break;
          this.events.onCommandSent?.(a.endSilenceMs);
          if (this.stream) {
            this.stream.end(); // the sidecar already has these words, and may already be answering them
            this.stream = undefined;
          } else this.live.submitVoice(toBase64(a.wav));
          break;
        case "discard":
          break;
      }
    }
  }
}
