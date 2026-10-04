import type { ChatMessage } from "@jarvis/providers";
import type { Intent } from "./intent";
import { detectSensitive } from "./sensitivity";
import { normalizeText } from "./text";

/**
 * Working memory of the current conversation (ADR-0023, M1). Without it every command is an isolated task: answering
 * "masculino" to "¿masculino o femenino?" reached the model alone. Kept in RAM only (never written to disk) and forgotten
 * after a period of inactivity, so what you said minutes ago is context, not a record.
 */
export interface ConversationOptions {
  enabled?: boolean;
  /** Most recent exchanges sent to the model. */
  maxTurns?: number;
  /** Character budget for the history (≈ chars/4 tokens); the oldest exchanges are dropped first. */
  maxChars?: number;
  /** Inactivity after which the conversation is over. */
  idleMs?: number;
  now?: () => number;
}

interface Turn {
  user: string;
  assistant: string;
  at: number;
}

const MAX_ASSISTANT_CHARS = 1_500;
const MAX_USER_CHARS = 1_000;
/** Placeholder for answers that must not be replayed to a model (they used untrusted external content). */
export const OMITTED_ANSWER = "[respuesta omitida: se basó en contenido externo no confiable]";

/** A message that starts like a continuation ("y en python?", "pero por qué", "otro") or points back at something said before. */
const CONTINUATION =
  /^(?:y|e|pero|entonces|ademas|tambien|otro|otra|otros|otras|y si|ahora|and|but|then|also|another|what about|how about|now)\b|\b(?:eso|esto|ese|esa|esos|esas|lo mismo|el anterior|la anterior|lo anterior|ello|it|that|those|same|previous|above)\b/;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export class ConversationMemory {
  private turns: Turn[] = [];
  private on: boolean;
  private readonly maxTurns: number;
  private readonly maxChars: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(opts: ConversationOptions = {}) {
    this.on = opts.enabled ?? true;
    this.maxTurns = opts.maxTurns ?? 8;
    this.maxChars = opts.maxChars ?? 6_000;
    this.idleMs = opts.idleMs ?? 20 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.on;
  }

  setEnabled(enabled: boolean): void {
    this.on = enabled;
    if (!enabled) this.turns = [];
  }

  /** Drops everything if the conversation went quiet for too long. */
  private expire(): void {
    const last = this.turns.at(-1);
    if (last && this.now() - last.at > this.idleMs) this.turns = [];
  }

  /** Number of exchanges that would be sent to the model right now. */
  size(): number {
    return this.window().length;
  }

  /** The newest exchanges that fit the budget, oldest first. */
  private window(): Turn[] {
    if (!this.on) return [];
    this.expire();
    const picked: Turn[] = [];
    let chars = 0;
    for (const t of [...this.turns].reverse()) {
      const cost = t.user.length + t.assistant.length;
      if (picked.length >= this.maxTurns || (picked.length > 0 && chars + cost > this.maxChars)) break;
      picked.unshift(t);
      chars += cost;
    }
    return picked;
  }

  /** The history as chat messages (user, assistant, user, assistant…), to put before the new request. */
  messages(): ChatMessage[] {
    return this.window().flatMap((t): ChatMessage[] => [
      { role: "user", content: t.user },
      { role: "assistant", content: t.assistant },
    ]);
  }

  /**
   * The new message only makes sense with the previous exchange: the assistant just asked something, or it is a one- or
   * two-word reply ("masculino", "sí", "con ejemplos"), or it reads as a continuation ("y en python?", "otro", "explica eso").
   * Such messages must not be answered from the cache, learned into it, or routed (and matched against memories) as if they were
   * questions on their own. A short but complete question ("¿quién ganó el mundial?") is NOT a follow-up.
   */
  isFollowUp(input: string): boolean {
    const last = this.window().at(-1);
    if (!last) return false;
    const text = normalizeText(input);
    const words = text.split(" ").filter(Boolean).length;
    return last.assistant.slice(-240).includes("?") || words <= 2 || CONTINUATION.test(text);
  }

  /** What a follow-up is about, for classifying its difficulty: the previous question plus the reply. */
  routingText(input: string): string {
    const last = this.window().at(-1);
    return last && this.isFollowUp(input) ? `${last.user} ${input}` : input;
  }

  /**
   * Remembers an exchange. Anything that looks like a secret is dropped entirely: it would otherwise ride along to a cloud
   * model on every later turn.
   */
  record(user: string, assistant: string): boolean {
    if (!this.on) return false;
    const text = assistant.trim();
    if (!user.trim() || !text) return false;
    if (detectSensitive(user).sensitive || detectSensitive(text).sensitive) return false;
    this.expire();
    this.turns.push({ user: clip(user.trim(), MAX_USER_CHARS), assistant: clip(text, MAX_ASSISTANT_CHARS), at: this.now() });
    if (this.turns.length > 50) this.turns.splice(0, this.turns.length - 50);
    return true;
  }

  /** Forgets the conversation; returns how many exchanges were dropped. */
  clear(): number {
    const n = this.window().length;
    this.turns = [];
    return n;
  }
}

/** "Olvida esta conversación", "empecemos de nuevo", "nueva conversación" (and English). Pass to `IntentRouter({ rules })`. */
export const conversationControlRules: ((text: string) => Intent | undefined)[] = [
  (t) =>
    /^(?:olvida|borra|limpia|reinicia|resetea|forget|clear|reset)\s+(?:esta\s+|la\s+|nuestra\s+|this\s+|the\s+|our\s+)?(?:conversacion|charla|chat|conversation)$/.test(t) ||
    /^(?:nueva conversacion|new conversation|empecemos de nuevo|empezamos de nuevo|empeza de nuevo|empieza de nuevo|start over|let'?s start over)$/.test(t)
      ? { route: "local", intent: "conversation.clear", tool: "conversation.clear", args: {}, confidence: 1 }
      : undefined,
];
