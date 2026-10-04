import { randomUUID } from "node:crypto";
import { HashedNgramEmbedder, cosine, sameContent, withinOneEdit, type Embedder } from "./instant-cache";
import type { Intent } from "./intent";
import { detectSensitive } from "./sensitivity";
import { normalizeText } from "./text";

/**
 * Long-term memory (ADR-0023, M2): short facts and preferences the user explicitly asked JARVIS to remember.
 * Written ONLY from the user's own explicit request, by deterministic rules; the model can read it but never write it
 * (a poisoned tool result must not become a permanent belief). Credentials are refused. Everything is listable and erasable.
 */
export type MemoryKind = "fact" | "preference";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  createdAt: number;
  /** Last time it was put into a prompt, and how many times. Shown to the user so they can see what is actually used. */
  usedAt?: number;
  uses: number;
}

/** Persistence behind the book (SQLite in the sidecar). Synchronous like the other stores. */
export interface MemoryStore {
  list(): MemoryItem[];
  save(item: MemoryItem): void;
  remove(id: string): void;
  clear(): void;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

export class MemoryMemoryStore implements MemoryStore {
  private readonly items = new Map<string, MemoryItem>();
  private readonly meta = new Map<string, string>();
  list = (): MemoryItem[] => [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  save = (item: MemoryItem): void => void this.items.set(item.id, { ...item });
  remove = (id: string): void => void this.items.delete(id);
  clear = (): void => this.items.clear();
  getMeta = (k: string): string | undefined => this.meta.get(k);
  setMeta = (k: string, v: string): void => void this.meta.set(k, v);
}

export const MEMORY_MAX_TEXT = 300;
const ENABLED_KEY = "memory.enabled";

export type AddResult =
  | { ok: true; item: MemoryItem; duplicate: boolean }
  | { ok: false; reason: "disabled" | "empty" | "too_long" | "sensitive" | "full"; message: string };

export type ForgetResult =
  | { ok: true; removed: MemoryItem[] }
  | { ok: false; reason: "none" | "ambiguous" | "empty"; candidates: MemoryItem[] };

export interface Retrieved {
  item: MemoryItem;
  score: number;
}

export interface MemoryBookOptions {
  store?: MemoryStore;
  embedder?: Embedder;
  enabled?: boolean;
  /** Saved items allowed in total. Refuses new ones beyond this instead of silently dropping old ones. */
  maxItems?: number;
  /** Minimum relevance (0..1) for a fact to be put into a prompt. Tuned with `memory-eval`. */
  minScore?: number;
  /** Facts per request / characters they may take. */
  maxFacts?: number;
  factBudgetChars?: number;
  /** Preferences are always applied (they are standing instructions); at most this many characters of them. */
  preferenceBudgetChars?: number;
  now?: () => number;
}

// ---- text matching -----------------------------------------------------------------------------

/** Function words and the words that every personal sentence shares ("mi", "se llama"): they say nothing about topic. */
const STOP = new Set(
  (
    "el la los las un una unos unas de del al a en y o u e que es son ser soy eres era fue por para con sin se lo le les su sus tu tus mi mis me te nos " +
    "yo vos tengo tiene tienen tenes hay esta este esto estos estas ese esa eso muy mas menos como cual cuales cuando donde quien quienes cuanto " +
    "porque pero si no ni ya ha han he hace hacer puedo puedes podes dime decime dame quiero quieres queres necesito sabes sabe " +
    // Auxiliary verbs: "¿para qué ESTOY entrenando?" must not match "ESTOY construyendo un asistente…" (measured: it did, and the
    // model then invented an answer from the wrong memory).
    "estoy estas estamos estan estaba estuve voy vas va vamos van hago haces hacemos puede pueden debo debe tienes " +
    "im ive id dont doesnt am going " +
    "the a an of to in on at and or is are am be was were for with my me i you your his her its our their that this these those " +
    "do does did can could would should will what which who how when where why please tell give want need know have has had"
  ).split(" "),
);

/** Cheap Spanish/English plural and verb-ending folding so "hermanas" ~ "hermana" and "likes" ~ "like". */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

export function memoryTokens(text: string): string[] {
  return normalizeText(text)
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t)) // a bare number ("2018", "3") matches by coincidence
    .map(stem);
}

/** Same word, or a one-letter typo of a LONG word ("corrr" must not match "correo" and "correo" must not match "correr"). */
const tokenMatches = (a: string, b: string): boolean => a === b || (a.length >= 7 && b.length >= 7 && withinOneEdit(a, b));

/** The question is about the user themself ("mi hermana", "donde vivo", "tengo"), which makes framing words informative. */
const FIRST_PERSON = /\b(?:mi|mis|mio|mia|mios|mias|yo|conmigo|vivo|trabajo|tengo|soy|estoy|estudio|uso|my|mine|i|me|myself)\b/;

/**
 * Words that frame a personal statement ("se llama", "vive", "trabaja", "favorito") and so appear in many unrelated memories
 * and questions. Sharing one of them is weak evidence of relevance; sharing a topical word ("gato", "hermana", "Bogotá") is strong.
 */
const FRAME = new Set(
  "llama llamo llaman nombre vive vivo viven tiene gusta gustan trabaja trabajo favorito favorita casa edad ano anos name named called live lives like likes work works favorite favourite home age".split(" "),
);
const W_TOPIC = 0.85;
/** A framing word alone is weak: "¿cómo se llama la capital de Colombia?" must not wake up every "se llama" memory. */
const W_FRAME = 0.3;
/**
 * Words about the user's own situation (where they live, what they do) say more when the question is about the user
 * ("recomiéndame un restaurante cerca de donde vivo"). Name words ("se llama") stay weak: they appear in too many memories.
 */
const W_FRAME_PERSONAL = 0.6;
const SITUATION = new Set("vivo vive viven live lives trabajo trabaja work works casa home edad age".split(" "));

/** Does the user's sentence read like a standing preference rather than a fact? */
export function inferKind(text: string): MemoryKind {
  const t = normalizeText(text);
  return /^(?:prefiero|preferimos|me gusta|me gustan|no me gusta|no me gustan|odio|detesto|quiero que|siempre|nunca|por favor siempre|evita|no quiero que|i prefer|i like|i love|i hate|i dont like|always|never|please always|avoid|i want you to)\b/.test(t)
    ? "preference"
    : "fact";
}

const clean = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .replace(/^["“'«]+|["”'»]+$/g, "")
    .trim();

// ---- the book ------------------------------------------------------------------------------------

export class MemoryBook {
  private readonly store: MemoryStore;
  private readonly embedder: Embedder;
  private readonly maxItems: number;
  private readonly now: () => number;
  readonly minScore: number;
  private readonly maxFacts: number;
  private readonly factBudget: number;
  private readonly prefBudget: number;
  private readonly defaultEnabled: boolean;
  private vectors = new Map<string, Float32Array>();

  constructor(opts: MemoryBookOptions = {}) {
    this.store = opts.store ?? new MemoryMemoryStore();
    this.embedder = opts.embedder ?? new HashedNgramEmbedder();
    this.defaultEnabled = opts.enabled ?? true;
    this.maxItems = opts.maxItems ?? 200;
    this.minScore = opts.minScore ?? 0.55;
    this.maxFacts = opts.maxFacts ?? 5;
    this.factBudget = opts.factBudgetChars ?? 700;
    this.prefBudget = opts.preferenceBudgetChars ?? 400;
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    const v = this.store.getMeta(ENABLED_KEY);
    return v === undefined ? this.defaultEnabled : v === "1";
  }

  setEnabled(enabled: boolean): void {
    this.store.setMeta(ENABLED_KEY, enabled ? "1" : "0");
  }

  list(): MemoryItem[] {
    return this.store.list();
  }

  get size(): number {
    return this.store.list().length;
  }

  /** Saves what the user asked to remember. The only way anything enters the book. */
  add(raw: string, kind?: MemoryKind): AddResult {
    if (!this.enabled) return { ok: false, reason: "disabled", message: "La memoria está desactivada: no guardé nada." };
    const text = clean(raw);
    if (memoryTokens(text).length === 0) return { ok: false, reason: "empty", message: "No entendí qué recordar." };
    if (text.length > MEMORY_MAX_TEXT) return { ok: false, reason: "too_long", message: `Es demasiado largo para recordarlo (máximo ${MEMORY_MAX_TEXT} caracteres): resúmelo.` };
    if (detectSensitive(text).sensitive) return { ok: false, reason: "sensitive", message: "No guardo contraseñas, claves ni números de tarjeta o cuenta." };

    const items = this.store.list();
    const same = items.find((i) => sameContent(i.text, text, 0.8));
    if (same) return { ok: true, item: same, duplicate: true };
    if (items.length >= this.maxItems) return { ok: false, reason: "full", message: `La memoria está llena (${this.maxItems}). Olvida algo primero.` };

    const item: MemoryItem = { id: randomUUID().slice(0, 8), kind: kind ?? inferKind(text), text, createdAt: this.now(), uses: 0 };
    this.store.save(item);
    return { ok: true, item, duplicate: false };
  }

  /**
   * Forgets by id or by describing it. If the description fits more than one item and none clearly best, nothing is erased
   * (the candidates are returned so the user can be specific).
   */
  forget(query: string): ForgetResult {
    const q = clean(query);
    if (!q) return { ok: false, reason: "empty", candidates: [] };
    const items = this.store.list();
    const byId = items.find((i) => i.id === q);
    if (byId) return this.remove([byId]);

    const scored = items
      .map((item) => ({ item, score: this.lexical(q, item, items) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 0.45) return { ok: false, reason: "none", candidates: [] };
    const rivals = scored.filter((s) => s.score >= best.score * 0.85);
    if (rivals.length > 1) return { ok: false, reason: "ambiguous", candidates: rivals.map((r) => r.item) };
    return this.remove([best.item]);
  }

  private remove(items: MemoryItem[]): ForgetResult {
    for (const i of items) {
      this.store.remove(i.id);
      this.vectors.delete(i.id);
    }
    return { ok: true, removed: items };
  }

  /** Erases everything; returns how many items were removed. */
  clear(): number {
    const n = this.store.list().length;
    this.store.clear();
    this.vectors.clear();
    return n;
  }

  // ---- retrieval ----

  /**
   * How convincingly the item shares words with the query (0..1): each shared word counts as evidence (a topical word a lot,
   * a framing word a little) and the evidence adds up like independent clues. It does not matter how many OTHER words the
   * question has: "recomiéndame un regalo para mi hermana" must find "mi hermana se llama Ana" through "hermana" alone.
   */
  private lexical(query: string, item: MemoryItem, _corpus: MemoryItem[]): number {
    const mine = memoryTokens(item.text);
    const personal = FIRST_PERSON.test(normalizeText(query));
    let miss = 1;
    for (const t of new Set(memoryTokens(query))) if (mine.some((x) => tokenMatches(t, x))) miss *= 1 - (FRAME.has(t) ? (personal && SITUATION.has(t) ? W_FRAME_PERSONAL : W_FRAME) : W_TOPIC);
    return 1 - miss;
  }

  private vector(item: MemoryItem): Float32Array {
    let v = this.vectors.get(item.id);
    if (!v) this.vectors.set(item.id, (v = this.embedder.embed(item.text)));
    return v;
  }

  /** Relevance of one item to a request, 0..1: topical word overlap (weighted by rarity) blended with wording similarity. */
  score(query: string, item: MemoryItem, corpus: MemoryItem[] = this.store.list()): number {
    const lex = this.lexical(query, item, corpus);
    // Shared words are the signal; wording similarity only breaks ties (it can never lift an item with no shared word over the bar).
    const sem = Math.max(0, cosine(this.embedder.embed(query), this.vector(item)));
    return Math.min(1, lex + (lex > 0 ? 0.1 * sem : 0));
  }

  /**
   * What to put into the prompt for this request: the user's standing preferences (always, within a small budget) and the
   * saved facts that are relevant (best first, within count and size budgets). Nothing when memory is off.
   */
  retrieve(query: string): { preferences: MemoryItem[]; facts: Retrieved[] } {
    if (!this.enabled) return { preferences: [], facts: [] };
    const items = this.store.list();
    if (items.length === 0) return { preferences: [], facts: [] };

    const preferences: MemoryItem[] = [];
    let used = 0;
    for (const p of items.filter((i) => i.kind === "preference").reverse()) {
      if (used + p.text.length > this.prefBudget) break;
      preferences.push(p);
      used += p.text.length;
    }

    const facts: Retrieved[] = [];
    used = 0;
    const ranked = items
      .filter((i) => i.kind === "fact")
      .map((item) => ({ item, score: this.score(query, item, items) }))
      .filter((r) => r.score >= this.minScore)
      .sort((a, b) => b.score - a.score);
    for (const r of ranked) {
      if (facts.length >= this.maxFacts || used + r.item.text.length > this.factBudget) break;
      facts.push(r);
      used += r.item.text.length;
    }
    return { preferences, facts };
  }

  /** Records that these items went into a prompt (shown in the list; never used to decide anything). */
  markUsed(ids: string[]): void {
    const at = this.now();
    for (const item of this.store.list()) {
      if (ids.includes(item.id)) this.store.save({ ...item, usedAt: at, uses: item.uses + 1 });
    }
  }
}

/** The text block added to the system prompt. Labelled as user-provided data, never as instructions from the system. */
export function memoryPrompt(preferences: readonly MemoryItem[], facts: readonly MemoryItem[]): string {
  const lines: string[] = [];
  if (preferences.length) lines.push("Standing preferences the user asked you to remember (follow them unless the user says otherwise):", ...preferences.map((p) => `- ${p.text}`));
  if (facts.length) lines.push("Things the user asked you to remember that may be relevant (use only if they help; do not mention them otherwise):", ...facts.map((f) => `- ${f.text}`));
  return lines.length ? ` ${lines.join("\n")}` : "";
}

// ---- local commands --------------------------------------------------------------------------------

const LEAD = "(?:(?:jarvis|oye|hey|ok|che|mira|por favor|please)[\\s,]+)*";
// "recuerda" / "acuérdate" / "anota" / "guarda" need "que" (or a colon) so "guarda el archivo" and "recuerda abrir paint" are not memories.
const SAVE_ES = new RegExp(`^\\s*${LEAD}(?:recuerda|record[aá]|acu[eé]rdate|acordate|anota|guarda|memoriza)(?:\\s+de)?(?:\\s+en\\s+(?:tu\\s+)?memoria)?\\s*(?:que\\b|:)\\s*(.+?)\\s*[.!]?\\s*$`, "is");
const SAVE_ES_MEMORIZA = new RegExp(`^\\s*${LEAD}memoriza\\s+(.+?)\\s*[.!]?\\s*$`, "is");
const SAVE_EN = new RegExp(`^\\s*${LEAD}(?:remember|keep in mind|make a note)\\s*(?:that\\b|:)\\s*(.+?)\\s*[.!]?\\s*$`, "is");

/** Rules for "recuerda que…", "qué recuerdas de mí", "olvida que…", "borra mi memoria", "desactiva la memoria". */
export const memoryControlRules: ((text: string, original: string) => Intent | undefined)[] = [
  (_t, original) => {
    const m = SAVE_ES.exec(original) ?? SAVE_EN.exec(original) ?? SAVE_ES_MEMORIZA.exec(original);
    return m?.[1] ? { route: "local", intent: "memory.add", tool: "memory.add", args: { text: m[1] }, confidence: 1 } : undefined;
  },
  (t) =>
    /^(?:que recuerdas de mi|que sabes de mi|que tienes anotado de mi|que tienes guardado de mi|que tienes en memoria|que hay en tu memoria|muestra mi memoria|mi memoria|lista mi memoria|what do you remember about me|what do you know about me|show my memory|list my memories|what is in your memory)$/.test(t)
      ? { route: "local", intent: "memory.list", tool: "memory.list", args: {}, confidence: 1 }
      : undefined,
  (t) =>
    /^(?:borra|olvida|elimina|forget|clear|delete)\s+(?:toda\s+|todo\s+)?(?:mi\s+|tu\s+|la\s+|my\s+)?(?:memoria|memory|todo lo que (?:sabes|recuerdas) (?:de|sobre) mi|everything (?:you know|you remember) about me|all memories|all my memories)$/.test(t)
      ? { route: "local", intent: "memory.clear", tool: "memory.clear", args: {}, confidence: 1 }
      : undefined,
  (t) => {
    const m = /^(?:olvida|borra|elimina|forget)\s+(?:que|lo de|lo que (?:te )?(?:dije|conte) (?:de|sobre)|sobre|that|about)\s+(.+)$/.exec(t);
    return m?.[1] ? { route: "local", intent: "memory.forget", tool: "memory.forget", args: { query: m[1] }, confidence: 1 } : undefined;
  },
  (t) => {
    const m = /^(desactiva|apaga|disable|activa|enciende|enable)\s+(?:la\s+|tu\s+|mi\s+|the\s+|your\s+)?(?:memoria|memory)(?: de largo plazo| a largo plazo)?$/.exec(t);
    return m?.[1] ? { route: "local", intent: "memory.toggle", tool: "memory.toggle", args: { enabled: /^(activa|enciende|enable)$/.test(m[1]) }, confidence: 1 } : undefined;
  },
];
