import type { OrchestratorEvent } from "@jarvis/protocol";
import { shouldSpeak, type SpeakMode } from "./policy";
import { detectLang, localConfirmation, speakable, type Lang } from "./text";

export interface Speaker {
  speak(text: string, lang: Lang): void;
  cancel(): void;
}

/**
 * Decides what is said for each task, purely from OrchestratorEvents (never invents content): the acknowledgement
 * immediately, then the answer, a short confirmation for local actions, or a plain failure notice. A new task, or the
 * user talking, interrupts whatever is still being said.
 */
export class TaskSpeaker {
  private modality: "text" | "voice" = "text";
  private lang: Lang = "es";
  private intent: string | undefined;
  private local = false;
  private buffer = "";
  private answered = false;
  private lastTool: { ok: boolean; summary?: string } | undefined;

  constructor(private readonly speaker: Speaker, private readonly mode: () => SpeakMode) {}

  private on(): boolean {
    return shouldSpeak(this.mode(), this.modality);
  }

  onEvent(e: OrchestratorEvent): void {
    switch (e.type) {
      case "task.started":
        this.speaker.cancel();
        this.modality = e.modality;
        this.lang = detectLang(e.input);
        this.intent = undefined;
        this.local = false;
        this.buffer = "";
        this.answered = false;
        this.lastTool = undefined;
        return;
      case "intent.resolved":
        this.local = e.route === "local";
        this.intent = e.intent;
        return;
      case "instant.issued":
        if (e.kind !== "ack") this.answered = true;
        if (this.on()) this.speaker.speak(e.text, detectLang(e.text));
        return;
      case "response.delta":
        this.buffer += e.text;
        return;
      case "escalated":
        this.buffer = ""; // only the final attempt is worth saying
        return;
      case "tool.completed":
        this.lastTool = { ok: e.ok, summary: e.summary };
        return;
      case "permission.required":
        if (this.on()) this.speaker.speak(this.lang === "es" ? "Necesito tu permiso." : "I need your permission.", this.lang);
        return;
      case "task.error":
        if (this.on()) this.speaker.speak(this.lang === "es" ? "Hubo un error." : "Something went wrong.", this.lang);
        this.answered = true;
        return;
      case "task.finished": {
        if (this.answered || !this.on() || e.outcome === "cancelled") return;
        this.answered = true;
        if (e.outcome === "failure") return void this.speaker.speak(this.lang === "es" ? "No pude completarlo." : "I couldn't do that.", this.lang);
        const text = this.local
          ? localConfirmation(this.intent, this.lastTool?.ok ?? true, this.lastTool?.summary ?? e.summary, this.lang)
          : this.buffer
            ? speakable(this.buffer, detectLang(this.buffer)).text
            : undefined;
        if (text) this.speaker.speak(text, detectLang(text));
        return;
      }
      default:
        return;
    }
  }
}
