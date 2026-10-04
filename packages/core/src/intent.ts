import { AppCatalog } from "./app-catalog";
import { cleanSpoken, normalizeText } from "./text";

export interface FollowUp {
  tool: string;
  args: Record<string, unknown>;
}

export type Intent =
  | {
      route: "local";
      intent: string;
      tool: string;
      args: Record<string, unknown>;
      confidence: number;
      /** Runs through the same policy path after the main tool succeeds; its failure does not fail the task. */
      then?: FollowUp;
    }
  | { route: "llm"; confidence: number };

export interface IntentRouterOptions {
  /** Known apps. A plain record is treated as fixed config aliases. Only known apps match, so "abre un debate" goes to the LLM. */
  apps: Record<string, string> | AppCatalog;
  /** Extra deterministic rules, tried after the built-ins. Return undefined to pass. */
  rules?: ((normalizedText: string, original: string) => Intent | undefined)[];
}

// Spoken requests are wordier than typed ones: "puedes abrir la calculadora por favor", "open the notepad".
const LEAD = "(?:(?:hey|oye|ok|che|jarvis|por favor|please|puedes|puedes tu|podrias|podria|podes|me puedes|me podes|me podrias|quiero que|necesito que|can you|could you|would you|will you|i want you to|i need you to|ahora|ya|vamos a)\\s+)*";
const OPEN_VERB = "(?:abre|abris|abrir|abriendo|abri|abrime|abreme|abrirme|abrirlo|abras|open|launch|inicia|iniciar|ejecuta|ejecutar|lanza|lanzar|arranca|arrancar)";
const OPEN_REQUEST = new RegExp(`^${LEAD}(?:me\\s+)?${OPEN_VERB}\\s+(.+)$`);
const FILLER_WORDS = /^(?:(?:me|up|la|el|los|las|un|una|the|a|an|mi|my|app|aplicacion|programa|application|program|de|of)\s+)+/;
const TRAILING = /(?:\s+(?:por favor|please|ahora|now|gracias|thanks|ya))+$/;

/** The app name inside an "open X" request, as the raw remainder and with articles/politeness removed; undefined if it is not one. */
export function extractOpenTarget(text: string): { raw: string; clean: string } | undefined {
  const m = OPEN_REQUEST.exec(text);
  if (!m?.[1]) return undefined;
  const raw = m[1].replace(TRAILING, "").trim();
  const clean = raw.replace(FILLER_WORDS, "").trim();
  return clean ? { raw, clean } : undefined;
}

const DAY_WORD = "(hoy|today|manana|tomorrow|ayer|yesterday)";
const DAY_QUERY = new RegExp(
  `^(?:que dia (?:es|sera|fue)|what day (?:is|will be|was)|que fecha es|what(?:'s| is) the date)(?:\\s+(?:el\\s+)?${DAY_WORD})?$`,
);

/** Deterministic, LLM-free intent rules (ES/EN). Anything unmatched falls through to the LLM. */
export class IntentRouter {
  private readonly catalog: AppCatalog;

  constructor(private readonly opts: IntentRouterOptions) {
    this.catalog = opts.apps instanceof AppCatalog ? opts.apps : AppCatalog.fromRecord(opts.apps);
  }

  resolve(input: string): Intent {
    // Spoken requests carry fillers and stutters ("che, eh, abrime el, el paint"); rules match the cleaned form.
    const text = cleanSpoken(normalizeText(input));

    if (/^(que hora es|what time is it|hora actual|current time)$/.test(text)) {
      return { route: "local", intent: "time.now", tool: "time.now", args: {}, confidence: 1 };
    }

    const day = DAY_QUERY.exec(text);
    if (day) {
      const word = day[1] ?? "hoy";
      const offsetDays = /^(manana|tomorrow)$/.test(word) ? 1 : /^(ayer|yesterday)$/.test(word) ? -1 : 0;
      return { route: "local", intent: "time.date", tool: "time.date", args: { offsetDays }, confidence: 1 };
    }

    if (/^(que alias (?:has aprendido|conoces|tengo)|list aliases|show aliases)$/.test(text)) {
      return { route: "local", intent: "aliases.list", tool: "aliases.list", args: {}, confidence: 1 };
    }
    const forget = /^(?:olvida|borra|forget)\s+(?:el\s+)?alias\s+(.+)$/.exec(text);
    if (forget?.[1]) return { route: "local", intent: "aliases.forget", tool: "aliases.forget", args: { alias: forget[1] }, confidence: 1 };

    const target = extractOpenTarget(text);
    if (target) {
      const command = this.catalog.lookup(target.raw) ?? this.catalog.lookup(target.clean);
      if (command) return { route: "local", intent: "apps.open", tool: "apps.open", args: { app: command }, confidence: 1 };

      // Near-match: open it now, then ask (via the policy engine) whether to remember this alias.
      const guess = this.catalog.suggest(target.clean);
      if (guess) {
        return {
          route: "local",
          intent: "apps.open",
          tool: "apps.open",
          args: { app: guess.command },
          confidence: 0.7,
          then: { tool: "aliases.learn", args: { alias: target.clean, command: guess.command } },
        };
      }
    }

    for (const rule of this.opts.rules ?? []) {
      // Rules match the normalised text; the original keeps casing and accents for rules that must store what was said.
      const hit = rule(text, input);
      if (hit) return hit;
    }

    return { route: "llm", confidence: 1 };
  }
}
