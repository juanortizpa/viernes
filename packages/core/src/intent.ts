export type Intent =
  | { route: "local"; intent: string; tool: string; args: Record<string, unknown>; confidence: number }
  | { route: "llm"; confidence: number };

export interface IntentRouterOptions {
  /** Spoken/typed alias (lowercase) -> launcher name. Only known apps match, so "abre un debate" goes to the LLM. */
  apps: Record<string, string>;
  /** Extra deterministic rules, tried after the built-ins. Return undefined to pass. */
  rules?: ((normalizedText: string) => Intent | undefined)[];
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!.,]/g, "")
    .trim();

/** Deterministic, LLM-free intent rules (ES/EN). Anything unmatched falls through to the LLM. */
export class IntentRouter {
  constructor(private readonly opts: IntentRouterOptions) {}

  resolve(input: string): Intent {
    const text = norm(input);

    if (/^(que hora es|what time is it|hora actual|current time)$/.test(text)) {
      return { route: "local", intent: "time.now", tool: "time.now", args: {}, confidence: 1 };
    }

    const day = /^(?:que dia (?:es|sera|fue)|what day (?:is|will be|was)|que fecha es|what(?:'s| is) the date)\s*(hoy|today|manana|tomorrow|ayer|yesterday)?(?:\s+(?:hoy|today|manana|tomorrow|ayer|yesterday))?$/.exec(text);
    if (day) {
      const word = day[1] ?? /(hoy|today|manana|tomorrow|ayer|yesterday)$/.exec(text)?.[1] ?? "hoy";
      const offsetDays = /^(manana|tomorrow)$/.test(word) ? 1 : /^(ayer|yesterday)$/.test(word) ? -1 : 0;
      return { route: "local", intent: "time.date", tool: "time.date", args: { offsetDays }, confidence: 1 };
    }

    const open =/^(?:abre|abrir|open|launch|inicia|iniciar)\s+(?:la app\s+|the app\s+)?(.+)$/.exec(text);
    const app = open?.[1] ? this.opts.apps[open[1]] : undefined;
    if (app) return { route: "local", intent: "apps.open", tool: "apps.open", args: { app }, confidence: 1 };

    for (const rule of this.opts.rules ?? []) {
      const hit = rule(text);
      if (hit) return hit;
    }

    return { route: "llm", confidence: 1 };
  }
}
