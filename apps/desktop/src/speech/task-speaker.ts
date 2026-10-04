import type { OrchestratorEvent } from "@jarvis/protocol";
import { shouldSpeak, type SpeakMode } from "./policy";
import { detectLang, localConfirmation, speakable, SKIP_NOTE, type Lang } from "./text";

export interface Speaker {
  speak(text: string, lang: Lang): void;
  cancel(): void;
}

/** How much of an answer is read aloud; the rest stays on screen. */
const MAX_SENTENCES = 3;
const MAX_CHARS = 280;
/** Long tasks: say what is really happening, at most this often, and only after this long without news. */
const PROGRESS_EVERY_MS = 10_000;
const PROGRESS_AFTER_MS = 6_000;

/**
 * Decides what is said for each task, purely from OrchestratorEvents (never invents content). Latency matters (ADR-0029): the answer
 * is spoken SENTENCE BY SENTENCE as the model writes it — the first words are heard when the first sentence exists, not when the whole
 * answer is done. Fillers/acknowledgements from the sidecar are spoken at once; long tasks narrate their real progress now and then.
 * A new task, or the user talking, interrupts whatever is still being said.
 */
export class TaskSpeaker {
  private modality: "text" | "voice" = "text";
  private lang: Lang = "es";
  private intent: string | undefined;
  private local = false;
  private buffer = "";
  /** How far into `buffer` has been handed to the speaker. */
  private spokenTo = 0;
  private sentences = 0;
  private chars = 0;
  /** Something of the answer was left unsaid (budget, code, tables). */
  private leftOut = false;
  /** Part of a failed attempt was already said before the cascade moved on. */
  private spokeFailedAttempt = false;
  private answered = false;
  private lastTool: { ok: boolean; summary?: string } | undefined;
  private startedAt = 0;
  private lastSaidAt = 0;
  private lastProgress = "";

  constructor(
    private readonly speaker: Speaker,
    private readonly mode: () => SpeakMode,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private on(): boolean {
    return shouldSpeak(this.mode(), this.modality);
  }

  private say(text: string, lang: Lang = detectLang(text)): void {
    this.lastSaidAt = this.now();
    this.speaker.speak(text, lang);
  }

  onEvent(e: OrchestratorEvent): void {
    switch (e.type) {
      case "task.started":
        this.speaker.cancel();
        this.modality = e.modality;
        this.lang = detectLang(e.input);
        this.intent = undefined;
        this.local = false;
        this.resetAnswer();
        this.spokeFailedAttempt = false;
        this.answered = false;
        this.lastTool = undefined;
        this.startedAt = this.lastSaidAt = this.now();
        this.lastProgress = "";
        return;
      case "intent.resolved":
        this.local = e.route === "local";
        this.intent = e.intent;
        return;
      case "instant.issued":
        if (e.kind !== "ack") this.answered = true;
        if (this.on()) this.say(e.text);
        return;
      case "response.delta":
        this.buffer += e.text;
        if (this.on() && !this.local) this.flush(false);
        return;
      case "escalated":
        // Only the final attempt is worth saying. If part of the failed one was already spoken, the next answer says so.
        if (this.spokenTo > 0) this.spokeFailedAttempt = true;
        this.resetAnswer();
        return;
      case "tool.completed":
        this.lastTool = { ok: e.ok, summary: e.summary };
        return;
      case "progress":
        return this.narrate(e.stage);
      case "permission.required":
        if (this.on()) this.say(this.lang === "es" ? "Necesito tu permiso." : "I need your permission.", this.lang);
        return;
      case "task.error":
        if (this.on()) this.say(this.lang === "es" ? "Hubo un error." : "Something went wrong.", this.lang);
        this.answered = true;
        return;
      case "task.finished": {
        if (this.answered || !this.on() || e.outcome === "cancelled") return;
        this.answered = true;
        if (e.outcome === "failure" && this.spokenTo === 0) return void this.say(this.lang === "es" ? "No pude completarlo." : "I couldn't do that.", this.lang);
        if (this.local) {
          const text = localConfirmation(this.intent, this.lastTool?.ok ?? true, this.lastTool?.summary ?? e.summary, this.lang);
          if (text) this.say(text);
          return;
        }
        this.flush(true);
        if (this.leftOut) this.say(SKIP_NOTE[this.lang], this.lang);
        return;
      }
      default:
        return;
    }
  }

  private resetAnswer(): void {
    this.buffer = "";
    this.spokenTo = 0;
    this.sentences = 0;
    this.chars = 0;
    this.leftOut = false;
  }

  /**
   * Speaks every complete sentence written since the last call (all the rest when `end`). Never splits inside a code block, and
   * never reads code or tables (they are noted as left on screen). Stops at the spoken budget.
   */
  private flush(end: boolean): void {
    const cut = end ? this.buffer.length : lastSentenceEnd(this.buffer, this.spokenTo);
    if (cut <= this.spokenTo) return;
    const chunk = this.buffer.slice(this.spokenTo, cut);
    this.spokenTo = cut;
    if (this.sentences >= MAX_SENTENCES || this.chars >= MAX_CHARS) {
      if (chunk.trim()) this.leftOut = true;
      return;
    }
    const s = speakable(chunk, detectLang(this.buffer));
    if (s.skippedStructured) this.leftOut = true;
    let text = s.text.replace(new RegExp(`\\s*${escapeRe(SKIP_NOTE.es)}|\\s*${escapeRe(SKIP_NOTE.en)}`, "g"), "").trim();
    if (!text) return;
    const parts = text.match(/.+?(?:[.!?…]+(?=\s|$)|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
    const room = MAX_SENTENCES - this.sentences;
    if (parts.length > room) (this.leftOut = true), (text = parts.slice(0, room).join(" "));
    if (this.chars + text.length > MAX_CHARS) {
      this.leftOut = true;
      text = text.slice(0, Math.max(0, MAX_CHARS - this.chars)).replace(/\s+\S*$/, "");
      if (!text) return;
      text += "…";
    }
    this.sentences += Math.min(parts.length, room);
    this.chars += text.length;
    if (this.spokeFailedAttempt) (text = `${this.lang === "es" ? "Mejor dicho:" : "Rather:"} ${text}`), (this.spokeFailedAttempt = false);
    this.say(text);
  }

  /** Long tasks only: now and then, say the real stage (from the tool's own progress) so the silence is not mistaken for a hang. */
  private narrate(stage: string): void {
    if (!this.on() || this.answered) return;
    const t = this.now();
    if (t - this.startedAt < PROGRESS_AFTER_MS || t - this.lastSaidAt < PROGRESS_EVERY_MS) return;
    const text = stage.replace(/^(Gemini|Claude Code|Rutina «[^»]+»):\s*/, "").replace(/«|»/g, "").trim();
    if (!text || text === this.lastProgress) return;
    this.lastProgress = text;
    this.say(text.endsWith(".") ? text : `${text}.`);
  }
}

/** End (exclusive) of the last complete sentence after `from`, outside code fences; `from` when there is none yet. */
export function lastSentenceEnd(text: string, from: number): number {
  let best = from;
  const re = /[.!?…]+(?=\s)|\n\s*\n/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if ((text.slice(0, end).match(/```/g)?.length ?? 0) % 2 === 1) continue; // inside a code block
    if (/\d$/.test(text.slice(0, m.index)) && /^\.\d/.test(text.slice(m.index))) continue; // 1.560
    best = end;
  }
  return best;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
