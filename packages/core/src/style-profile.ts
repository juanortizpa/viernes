import { detectSensitive } from "./sensitivity";
import { detectLanguage } from "./instant";
import type { Intent } from "./intent";
import { normalizeText } from "./text";

/**
 * R3 of the instant layer (ADR-0015): how the user talks, learned from their own messages with plain counters.
 * No model and no stored text: only aggregate counts, and the prompt hint is built from fixed phrases (nothing the user
 * typed can reach the system prompt through here).
 */
export interface ProfileStore {
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

export interface StyleCounters {
  /** Messages observed. */
  n: number;
  es: number;
  en: number;
  /** Register markers seen (not messages): vos/tenés, tú/tienes, usted. */
  voseo: number;
  tuteo: number;
  usted: number;
  /** Explicit requests for short answers ("resumen", "en pocas palabras", "brief"). */
  brief: number;
}

const EMPTY: StyleCounters = { n: 0, es: 0, en: 0, voseo: 0, tuteo: 0, usted: 0, brief: 0 };
const KEY = "style.counters";
const ENABLED_KEY = "style.enabled";

// Tested on accent-free, lowercase text. Only markers that are NOT shared between registers.
const VOSEO = /\b(vos|tenes|queres|podes|sos|decime|contame|pasame|mandame|avisame|fijate|dale|che|hace de cuenta)\b/g;
const TUTEO = /\b(tienes|quieres|puedes|eres|dime|cuentame|tu|tus)\b/g;
const USTED = /\b(usted|ustedes|quisiera|le agradeceria|podria usted)\b/g;
const BRIEF = /\b(breve|corto|corta|resumen|resume|en pocas palabras|brief|short|tl;?dr|concise|in a nutshell)\b/g;

const count = (re: RegExp, s: string): number => s.match(re)?.length ?? 0;

export interface StyleTrackerOptions {
  store?: ProfileStore;
  /** Messages needed before any hint is produced. */
  minObservations?: number;
  enabled?: boolean;
}

export class StyleTracker {
  private readonly store: ProfileStore;
  private readonly minObs: number;
  private readonly defaultEnabled: boolean;
  private counters: StyleCounters;

  constructor(opts: StyleTrackerOptions = {}) {
    this.store =
      opts.store ??
      (() => {
        const m = new Map<string, string>();
        return { getMeta: (k) => m.get(k), setMeta: (k, v) => void m.set(k, v) };
      })();
    this.minObs = opts.minObservations ?? 8;
    this.defaultEnabled = opts.enabled ?? true;
    this.counters = this.load();
  }

  private load(): StyleCounters {
    try {
      const raw = this.store.getMeta(KEY);
      return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<StyleCounters>) } : { ...EMPTY };
    } catch {
      return { ...EMPTY };
    }
  }

  get enabled(): boolean {
    const v = this.store.getMeta(ENABLED_KEY);
    return v === undefined ? this.defaultEnabled : v === "1";
  }

  setEnabled(enabled: boolean): void {
    this.store.setMeta(ENABLED_KEY, enabled ? "1" : "0");
  }

  /** Count the traits of one user message. Messages with secrets are ignored entirely. */
  observe(input: string): void {
    if (!this.enabled || input.length < 3 || input.length > 2_000 || detectSensitive(input).sensitive) return;
    const t = normalizeText(input);
    const c = this.counters;
    c.n++;
    c[detectLanguage(input)]++;
    c.voseo += count(VOSEO, t);
    c.tuteo += count(TUTEO, t);
    c.usted += count(USTED, t);
    c.brief += count(BRIEF, t);
    this.store.setMeta(KEY, JSON.stringify(c));
  }

  /** What has been learned, for the user to read. */
  summary(): { observations: number; spanishShare: number; register: "voseo" | "tuteo" | "usted" | undefined; prefersShort: boolean } {
    const c = this.counters;
    return { observations: c.n, spanishShare: c.n ? c.es / c.n : 0, register: this.register(), prefersShort: this.prefersShort() };
  }

  private register(): "voseo" | "tuteo" | "usted" | undefined {
    const c = this.counters;
    const total = c.voseo + c.tuteo + c.usted;
    if (total < 3) return undefined; // too little evidence
    const [name, n] = (["voseo", "tuteo", "usted"] as const).map((k) => [k, c[k]] as const).sort((a, b) => b[1] - a[1])[0]!;
    return n / total >= 0.6 ? name : undefined;
  }

  private prefersShort(): boolean {
    return this.counters.brief >= 3;
  }

  /** A fixed-phrase line for the system prompt, or undefined while the evidence is thin or the profile is off. */
  hint(): string | undefined {
    if (!this.enabled || this.counters.n < this.minObs) return undefined;
    const parts: string[] = [];
    const reg = this.register();
    if (reg === "voseo") parts.push("The user speaks Spanish with voseo (vos, tenés, podés); answer in the same register.");
    else if (reg === "tuteo") parts.push("The user addresses you informally (tú); answer in the same register.");
    else if (reg === "usted") parts.push("The user addresses you formally (usted); answer formally.");
    if (this.prefersShort()) parts.push("The user usually asks for brief answers; keep them short unless asked for detail.");
    return parts.length ? parts.join(" ") : undefined;
  }

  reset(): void {
    this.counters = { ...EMPTY };
    this.store.setMeta(KEY, JSON.stringify(this.counters));
  }

  describe(): string {
    const s = this.summary();
    if (!this.enabled) return "el aprendizaje de estilo está desactivado";
    if (s.observations === 0) return "todavía no he aprendido nada de tu forma de hablar";
    const bits = [`${s.observations} mensajes observados`, `${Math.round(s.spanishShare * 100)}% en español`];
    bits.push(s.register ? `registro: ${s.register}` : "registro: sin evidencia suficiente");
    if (s.prefersShort) bits.push("prefieres respuestas breves");
    if (!this.hint()) bits.push(`(aún no se aplica: se necesitan ≥${this.minObs} mensajes y evidencia clara)`);
    return bits.join(", ");
  }
}

/** Local intents for the user's control over the style profile. Pass to `IntentRouter({ rules })`. */
export const styleControlRules: ((text: string) => Intent | undefined)[] = [
  (t) =>
    /^(como es mi estilo|que sabes de como hablo|que has aprendido de mi estilo|show my style|what do you know about how i talk)$/.test(t)
      ? { route: "local", intent: "style.show", tool: "style.show", args: {}, confidence: 1 }
      : undefined,
  (t) =>
    /^(olvida mi estilo|borra mi estilo|reset my style|forget my style)$/.test(t)
      ? { route: "local", intent: "style.reset", tool: "style.reset", args: {}, confidence: 1 }
      : undefined,
  (t) => {
    const m = /^(desactiva|apaga|disable|activa|enciende|enable)\s+(?:el\s+)?(?:aprendizaje de estilo|style learning)$/.exec(t);
    return m?.[1] ? { route: "local", intent: "style.toggle", tool: "style.toggle", args: { enabled: /^(activa|enciende|enable)$/.test(m[1]) }, confidence: 1 } : undefined;
  },
];
