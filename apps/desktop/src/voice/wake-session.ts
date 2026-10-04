import { WakeController, enrollmentFromJson, type Enrollment, type WakeAction, type WakeState } from "@jarvis/voice/audio";
import type { LiveClient } from "../live/client";
import { startContinuousMic, type ContinuousMic } from "./mic";
import { toBase64 } from "./pcm-buffer";

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
    try {
      this.mic = await startContinuousMic(
        (chunk) => {
          if (!this.paused) this.run(this.controller.onAudio(chunk));
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

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.offResult?.();
    this.offResult = undefined;
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
          this.events.onState(a.state, a.followUpMs);
          break;
        case "verify":
          if (this.live.status === "ready") this.live.verifyWake(toBase64(a.wav));
          else this.run(this.controller.onVerified({ detected: false, commandRan: false }));
          break;
        case "command":
          if (this.live.status === "ready") this.live.submitVoice(toBase64(a.wav));
          break;
        case "discard":
          break;
      }
    }
  }
}
