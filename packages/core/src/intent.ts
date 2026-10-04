import { AppCatalog } from "./app-catalog";
import { normalizeText } from "./text";

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
  rules?: ((normalizedText: string) => Intent | undefined)[];
}

const DAY_WORD = "(hoy|today|manana|tomorrow|ayer|yesterday)";
const DAY_QUERY = new RegExp(
  `^(?:que dia (?:es|sera|fue)|what day (?:is|will be|was)|que fecha es|what(?:'s| is) the date)(?:\\s+${DAY_WORD})?$`,
);

/** Deterministic, LLM-free intent rules (ES/EN). Anything unmatched falls through to the LLM. */
export class IntentRouter {
  private readonly catalog: AppCatalog;

  constructor(private readonly opts: IntentRouterOptions) {
    this.catalog = opts.apps instanceof AppCatalog ? opts.apps : AppCatalog.fromRecord(opts.apps);
  }

  resolve(input: string): Intent {
    const text = normalizeText(input);

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

    const open = /^(?:abre|abrir|open|launch|inicia|iniciar)\s+(?:la app\s+|the app\s+)?(.+)$/.exec(text);
    if (open?.[1]) {
      const command = this.catalog.lookup(open[1]);
      if (command) return { route: "local", intent: "apps.open", tool: "apps.open", args: { app: command }, confidence: 1 };

      // Near-match: open it now, then ask (via the policy engine) whether to remember this alias.
      const guess = this.catalog.suggest(open[1]);
      if (guess) {
        return {
          route: "local",
          intent: "apps.open",
          tool: "apps.open",
          args: { app: guess.command },
          confidence: 0.7,
          then: { tool: "aliases.learn", args: { alias: open[1], command: guess.command } },
        };
      }
    }

    for (const rule of this.opts.rules ?? []) {
      const hit = rule(text);
      if (hit) return hit;
    }

    return { route: "llm", confidence: 1 };
  }
}
