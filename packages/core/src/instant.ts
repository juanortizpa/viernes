import { normalizeText } from "./text";
import type { TaskClass } from "./task-classifier";

/**
 * Deterministic instant layer (ADR-0015, R1). No model, no learning: fixed templates.
 * It may only answer what cannot be wrong or stale (pleasantries) or confirm receipt of a long task.
 */
export interface InstantResponder {
  /** A complete answer for a pure pleasantry, or undefined. Must never match a message that also asks for something. */
  reply(input: string): string | undefined;
  /** A receipt-only confirmation for a task that will take a while, or undefined. It must not promise a result. */
  ack(input: string, cls: TaskClass): string | undefined;
}

type Lang = "es" | "en";
type Kind = "greeting" | "how" | "thanks" | "bye";

const PHRASES: Record<Kind, { es: string[]; en: string[] }> = {
  greeting: {
    es: ["hola", "holi", "buenas", "buenos dias", "buenas tardes", "buenas noches", "que tal", "hola que tal"],
    en: ["hi", "hey", "hello", "good morning", "good afternoon", "good evening"],
  },
  how: {
    es: ["como estas", "hola como estas", "buenas como estas", "como andas", "hola como andas"],
    en: ["how are you", "hi how are you", "hello how are you", "hey how are you", "how are you doing"],
  },
  thanks: { es: ["gracias", "muchas gracias", "mil gracias"], en: ["thanks", "thank you", "thanks a lot"] },
  bye: { es: ["adios", "chao", "hasta luego", "nos vemos"], en: ["bye", "goodbye", "see you"] },
};

const REPLIES: Record<Kind, Record<Lang, string>> = {
  greeting: { es: "¡Hola! ¿En qué te puedo ayudar?", en: "Hi! How can I help?" },
  how: { es: "¡Bien, gracias! ¿Y tú? ¿En qué te ayudo?", en: "Doing well, thanks! How can I help?" },
  thanks: { es: "¡De nada!", en: "You're welcome!" },
  bye: { es: "¡Hasta luego!", en: "See you later!" },
};

const ACKS: Record<Lang, string> = { es: "Entendido, me pongo con eso.", en: "Got it, I'm on it." };

const LOOKUP = new Map<string, { kind: Kind; lang: Lang }>();
for (const [kind, langs] of Object.entries(PHRASES) as [Kind, { es: string[]; en: string[] }][])
  for (const lang of ["es", "en"] as const) for (const p of langs[lang]) LOOKUP.set(p, { kind, lang });

const ES_HINT = /[áéíóúñ¿¡]|\b(el|la|los|las|un|una|que|por|para|con|mi|me|tu|de|en|es|y|crea|escribe|explica|haz|revisa|analiza|investiga|compara|arregla)\b/i;
const EN_HINT = /\b(the|a|an|to|of|and|is|my|me|please|create|write|explain|make|check|analy[sz]e|research|compare|fix)\b/i;

export function detectLanguage(input: string): Lang {
  const es = ES_HINT.test(input);
  const en = EN_HINT.test(input);
  return en && !es ? "en" : "es";
}

/** "Long" means the user would otherwise stare at nothing: heavy task types, tool use, or a big prompt. */
export function isLongTask(cls: TaskClass, input: string): boolean {
  return cls.needsTools || cls.complexity >= 0.6 || input.length > 400;
}

export class RuleInstantResponder implements InstantResponder {
  reply(input: string): string | undefined {
    // Addressing the assistant by name does not change the request ("hola jarvis").
    const text = normalizeText(input).replace(/\bjarvis\b/g, "").replace(/\s+/g, " ").trim();
    const hit = LOOKUP.get(text);
    return hit ? REPLIES[hit.kind][hit.lang] : undefined;
  }

  ack(input: string, cls: TaskClass): string | undefined {
    return isLongTask(cls, input) ? ACKS[detectLanguage(input)] : undefined;
  }
}
