import { randomUUID } from "node:crypto";
import type { TaskType } from "@jarvis/protocol";
import { classifyTask } from "./task-classifier";
import { detectSensitive } from "./sensitivity";
import { detectLanguage } from "./instant";
import { normalizeText } from "./text";

/**
 * R2 of the instant layer (ADR-0015): a small local cache of verified answers to questions the user asks repeatedly.
 * Conservative by construction: when in doubt it misses and the request goes to the model.
 */

export interface Embedder {
  readonly dim: number;
  embed(text: string): Float32Array;
}

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

/**
 * Dependency-free embedder: hashed word unigrams/bigrams and character trigrams (a few KB of code, no model file).
 * It captures wording similarity, not meaning; a neural embedder can replace it behind `Embedder` if measured data justifies it.
 */
export class HashedNgramEmbedder implements Embedder {
  constructor(readonly dim = 512) {}

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const add = (feature: string, w: number): void => {
      const h = fnv1a(feature);
      v[h % this.dim]! += (h & 0x80000000 ? -1 : 1) * w;
    };
    const words = normalizeText(text).split(/\s+/).filter(Boolean);
    words.forEach((w, i) => {
      add(`w:${w}`, 1);
      if (i > 0) add(`b:${words[i - 1]} ${w}`, 0.7);
      const padded = `^${w}$`;
      for (let k = 0; k + 3 <= padded.length; k++) add(`c:${padded.slice(k, k + 3)}`, 0.4);
    });
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return Math.max(-1, Math.min(1, dot)); // inputs are L2-normalised; clamp float error (1.0000002 would break a 0..1 confidence)
}

// ---- what may be cached -------------------------------------------------------------------------

/** Anything whose right answer changes with time or world state. */
const VOLATILE =
  /\b(hoy|ahora|actual|actualmente|ultimo|ultima|ultimos|reciente|recientes|manana|ayer|esta semana|este mes|este ano|clima|temperatura|precio|cotizacion|noticias|resultado|resultados|hora|fecha|today|now|current|currently|latest|recent|tomorrow|yesterday|weather|price|news|score|scores|time|date|tonight)\b/;
/** Answers that depend on the user or on earlier turns. */
const CONTEXTUAL =
  /\b(mi|mis|yo|conmigo|my|mine|eso|esto|esa|ese|lo anterior|anterior|continua|sigue|otra vez|de nuevo|this|that|previous|above|continue|again)\b/;

const CACHEABLE_TYPES: ReadonlySet<TaskType> = new Set<TaskType>(["qa_simple", "explanation", "other"]);
const MAX_INPUT_CHARS = 300;
const MAX_RESPONSE_CHARS = 2_000;

export interface CacheableVerdict {
  ok: boolean;
  reason?: string;
}

/** The exclusion list from ADR-0015 as code. Applied when reading AND when learning. */
export function isCacheable(input: string): CacheableVerdict {
  if (input.length === 0 || input.length > MAX_INPUT_CHARS) return { ok: false, reason: "length" };
  const cls = classifyTask(input);
  if (cls.needsTools) return { ok: false, reason: "needs tools" };
  if (!CACHEABLE_TYPES.has(cls.taskType)) return { ok: false, reason: `task type ${cls.taskType}` };
  if (detectSensitive(input).sensitive) return { ok: false, reason: "sensitive" };
  const text = normalizeText(input);
  if (VOLATILE.test(text)) return { ok: false, reason: "time/state dependent" };
  if (CONTEXTUAL.test(text)) return { ok: false, reason: "depends on user or context" };
  return { ok: true };
}

// ---- same question? -------------------------------------------------------------------------------

const STOP = new Set(
  (
    "el la los las un una unos unas de del al a en y o que es son ser por para con sin se lo le les su sus tu tus " +
    "cual cuales como cuando donde quien quienes cuanto cuantos porque dime decime puedes podrias podria quiero saber quisiera " +
    "favor por gracias hola oye jarvis explicame explica cuentame the a an of to in and or is are be was were for with " +
    "what which who whom whose how when where why do does did can could would please tell explain me i want know give about " +
    "tu es eres hay you your whats hows thats palabra word term termino significa significado definicion meaning mean means"
  ).split(" "),
);

export function contentTokens(text: string): string[] {
  return normalizeText(text)
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    // Adjacent transposition ("capitla"), the commonest typo.
    for (let k = 0; k + 1 < a.length; k++) if (a[k] !== b[k]) return a[k] === b[k + 1] && a[k + 1] === b[k] && a.slice(k + 2) === b.slice(k + 2);
  }
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ra = a.slice(i);
  const rb = b.slice(i);
  if (ra.length === rb.length) return ra.slice(1) === rb.slice(1);
  return ra.length > rb.length ? ra.slice(1) === rb : rb.slice(1) === ra;
}

/**
 * The guard that stops "capital de Francia" from matching "capital de Italia": the content words of both questions must
 * agree (typos of one letter tolerated on longer words) and every number must be identical.
 */
export function sameContent(a: string, b: string, minJaccard = 0.8): boolean {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const numsA = ta.filter((t) => /\d/.test(t)).sort().join(",");
  const numsB = tb.filter((t) => /\d/.test(t)).sort().join(",");
  if (numsA !== numsB) return false;
  const pool = [...tb];
  let shared = 0;
  for (const t of ta) {
    const i = pool.findIndex((u) => withinOneEdit(t, u));
    if (i >= 0) (shared++, pool.splice(i, 1));
  }
  return shared / (ta.length + tb.length - shared) >= minJaccard;
}

// ---- store + cache --------------------------------------------------------------------------------

export interface CacheEntry {
  id: string;
  input: string;
  response: string;
  embedding: Float32Array;
  /** Times a model answered this question (and was verified). The cache only serves once this reaches `minSeen`. */
  seen: number;
  /** Times the cache served it. */
  hits: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  model?: string;
}

/** Durable home of cache entries. Synchronous like the other stores. */
export interface InstantStore {
  all(): CacheEntry[];
  put(e: CacheEntry): void;
  remove(id: string): void;
  clear(): void;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

export class MemoryInstantStore implements InstantStore {
  private readonly items = new Map<string, CacheEntry>();
  private readonly meta = new Map<string, string>();
  all(): CacheEntry[] {
    return [...this.items.values()];
  }
  put(e: CacheEntry): void {
    this.items.set(e.id, e);
  }
  remove(id: string): void {
    this.items.delete(id);
  }
  clear(): void {
    this.items.clear();
  }
  getMeta(key: string): string | undefined {
    return this.meta.get(key);
  }
  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }
}

export interface CacheHit {
  entry: CacheEntry;
  score: number;
}

/** What the orchestrator needs; `SemanticCache` implements it. */
export interface InstantCache {
  lookup(input: string): CacheHit | undefined;
  learn(input: string, response: string, meta?: { model?: string }): void;
}

export interface SemanticCacheOptions {
  store?: InstantStore;
  embedder?: Embedder;
  /** Minimum cosine similarity (secondary to the content guard). */
  threshold?: number;
  /** Verified model answers required before the cache serves a question (it must be a *frequent* one). */
  minSeen?: number;
  maxEntries?: number;
  ttlMs?: number;
  enabled?: boolean;
  now?: () => number;
}

const DAY = 86_400_000;
const ENABLED_KEY = "enabled";

export class SemanticCache implements InstantCache {
  private readonly store: InstantStore;
  private readonly embedder: Embedder;
  private readonly threshold: number;
  private readonly minSeen: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly defaultEnabled: boolean;

  constructor(opts: SemanticCacheOptions = {}) {
    this.store = opts.store ?? new MemoryInstantStore();
    this.embedder = opts.embedder ?? new HashedNgramEmbedder();
    this.threshold = opts.threshold ?? 0.8;
    this.minSeen = opts.minSeen ?? 2;
    this.maxEntries = opts.maxEntries ?? 2_000;
    this.ttlMs = opts.ttlMs ?? 30 * DAY;
    this.now = opts.now ?? Date.now;
    this.defaultEnabled = opts.enabled ?? true;
  }

  get enabled(): boolean {
    const v = this.store.getMeta(ENABLED_KEY);
    return v === undefined ? this.defaultEnabled : v === "1";
  }

  setEnabled(enabled: boolean): void {
    this.store.setMeta(ENABLED_KEY, enabled ? "1" : "0");
  }

  /** Embed the content words only, so politeness and filler ("dime", "por favor") do not lower similarity. */
  private vector(text: string): Float32Array {
    return this.embedder.embed(contentTokens(text).join(" ") || text);
  }

  private best(input: string, entries: CacheEntry[]): CacheHit | undefined {
    const q = this.vector(input);
    const lang = detectLanguage(input);
    let best: CacheHit | undefined;
    for (const entry of entries) {
      const score = cosine(q, entry.embedding);
      if (score >= this.threshold && detectLanguage(entry.input) === lang && sameContent(input, entry.input) && (!best || score > best.score)) best = { entry, score };
    }
    return best;
  }

  lookup(input: string): CacheHit | undefined {
    if (!this.enabled || !isCacheable(input).ok) return undefined;
    const t = this.now();
    const live = this.store.all().filter((e) => e.seen >= this.minSeen && t - e.updatedAt <= this.ttlMs);
    const hit = this.best(input, live);
    if (!hit) return undefined;
    const entry = { ...hit.entry, hits: hit.entry.hits + 1, lastUsedAt: t };
    this.store.put(entry);
    return { entry, score: hit.score };
  }

  /** Remember a model answer that already passed an evaluator, with no tools and no taint (the orchestrator checks that). */
  learn(input: string, response: string, meta: { model?: string } = {}): void {
    if (!this.enabled || !isCacheable(input).ok) return;
    const text = response.trim();
    if (text.length === 0 || text.length > MAX_RESPONSE_CHARS) return;
    const t = this.now();
    const known = this.best(input, this.store.all());
    if (known) {
      // The newest verified answer wins; `seen` counts how often this question came back.
      this.store.put({ ...known.entry, response: text, seen: known.entry.seen + 1, updatedAt: t, ...(meta.model ? { model: meta.model } : {}) });
      return;
    }
    this.store.put({
      id: randomUUID(),
      input,
      response: text,
      embedding: this.vector(input),
      seen: 1,
      hits: 0,
      createdAt: t,
      updatedAt: t,
      lastUsedAt: t,
      ...(meta.model ? { model: meta.model } : {}),
    });
    this.prune();
  }

  private prune(): void {
    const all = this.store.all();
    if (all.length <= this.maxEntries) return;
    all.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const e of all.slice(0, all.length - this.maxEntries)) this.store.remove(e.id);
  }

  /** Entries without embeddings, for the user to inspect. */
  list(): { id: string; input: string; response: string; seen: number; hits: number; servable: boolean }[] {
    return this.store
      .all()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, input, response, seen, hits }) => ({ id, input, response, seen, hits, servable: seen >= this.minSeen }));
  }

  /** Remove by id, or by a fragment of the question. Returns how many entries were removed. */
  forget(idOrText: string): number {
    const needle = normalizeText(idOrText);
    const victims = this.store.all().filter((e) => e.id === idOrText || (needle.length >= 3 && normalizeText(e.input).includes(needle)));
    for (const e of victims) this.store.remove(e.id);
    return victims.length;
  }

  clear(): number {
    const n = this.store.all().length;
    this.store.clear();
    return n;
  }
}

/** Local intents for the user's control over the cache. Pass to `IntentRouter({ rules })`; the matching tools must be registered. */
export const instantControlRules: ((text: string) => import("./intent").Intent | undefined)[] = [
  (t) =>
    /^(que respuestas (?:tienes|has) guardadas|que respuestas guardadas tienes|list cached answers|show cached answers)$/.test(t)
      ? { route: "local", intent: "instant.list", tool: "instant.list", args: {}, confidence: 1 }
      : undefined,
  (t) => {
    const m = /^(?:olvida|borra|elimina|forget)\s+(?:la\s+)?respuestas?\s+(?:guardadas?\s+)?(?:de|sobre|about)\s+(.+)$/.exec(t);
    return m?.[1] ? { route: "local", intent: "instant.forget", tool: "instant.forget", args: { query: m[1] }, confidence: 1 } : undefined;
  },
  (t) =>
    /^(?:borra|elimina|clear|delete)\s+(?:todas\s+)?(?:las\s+)?(?:respuestas guardadas|cached answers|cache de respuestas)$/.test(t)
      ? { route: "local", intent: "instant.clear", tool: "instant.clear", args: {}, confidence: 1 }
      : undefined,
  (t) => {
    const m = /^(desactiva|apaga|disable|activa|enciende|enable)\s+(?:el\s+)?(?:cache de respuestas|respuestas guardadas|cached answers)$/.exec(t);
    return m?.[1] ? { route: "local", intent: "instant.toggle", tool: "instant.toggle", args: { enabled: /^(activa|enciende|enable)$/.test(m[1]) }, confidence: 1 } : undefined;
  },
];
