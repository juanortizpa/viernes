import { HashedNgramEmbedder, MemoryBook, MemoryMemoryStore, cosine, type Embedder, type MemoryKind } from "@jarvis/core";
import { memoryFacts, memoryQueries, type MemoryQuerySpec } from "./suites/memory-corpus";

/** Which memories (by corpus key) a strategy would put into the prompt for a query. */
export interface Retriever {
  name: string;
  retrieve(query: string): string[];
}

export interface MemoryEvalRow {
  strategy: string;
  /** Queries with a wanted memory: share where at least one wanted memory was retrieved / all of them were. */
  recallAny: number;
  recallAll: number;
  /** Retrieved memories that were wanted or acceptable / all retrieved, over the relevant queries. */
  precision: number;
  /** Queries that need nothing: share that still got a memory injected. */
  falseInjection: number;
  /** Mean characters injected per query (prompt cost). */
  charsPerQuery: number;
  relevantQueries: number;
  noneQueries: number;
}

const zeroEmbedder: Embedder = { dim: 1, embed: () => new Float32Array(1) };

const keyOf = new Map(memoryFacts.map((f) => [f.text, f.key]));
const textOf = new Map(memoryFacts.map((f) => [f.key, f.text]));

function loadBook(embedder: Embedder, over: ConstructorParameters<typeof MemoryBook>[0] = {}): MemoryBook {
  const book = new MemoryBook({ store: new MemoryMemoryStore(), embedder, maxItems: 1_000, ...over });
  for (const f of memoryFacts) {
    const kind: MemoryKind = f.key.startsWith("p-") ? "preference" : "fact";
    const r = book.add(f.text, kind);
    if (!r.ok) throw new Error(`corpus item "${f.key}" was refused: ${r.message}`);
  }
  return book;
}

/** The facts (not the always-on preferences) a book would inject. */
const factKeys = (book: MemoryBook, q: string): string[] => book.retrieve(q).facts.map((f) => keyOf.get(f.item.text)!);

export const retrievers = {
  /** Baseline: no memory at all. */
  none: (): Retriever => ({ name: "sin memoria", retrieve: () => [] }),
  /** Baseline: put every fact in every prompt. */
  all: (): Retriever => ({ name: "todo siempre", retrieve: () => memoryFacts.filter((f) => !f.key.startsWith("p-")).map((f) => f.key) }),
  /** Baseline: the best 3 by score whatever it is. */
  top3: (): Retriever => {
    const book = loadBook(new HashedNgramEmbedder(), { minScore: 0, maxFacts: 3, factBudgetChars: 10_000 });
    return { name: "top-3 siempre", retrieve: (q) => factKeys(book, q) };
  },
  /** Wording similarity only (the hashed n-gram embedder), no word matching. */
  embedding: (threshold: number): Retriever => {
    const emb = new HashedNgramEmbedder();
    const facts = memoryFacts.filter((f) => !f.key.startsWith("p-")).map((f) => ({ key: f.key, v: emb.embed(f.text) }));
    return {
      name: `solo embedding ≥${threshold.toFixed(2)}`,
      retrieve: (q) => {
        const v = emb.embed(q);
        return facts
          .map((f) => ({ key: f.key, s: cosine(v, f.v) }))
          .filter((x) => x.s >= threshold)
          .sort((a, b) => b.s - a.s)
          .slice(0, 5)
          .map((x) => x.key);
      },
    };
  },
  /** Shared words only (the embedder contributes nothing). */
  lexical: (threshold: number): Retriever => {
    const book = loadBook(zeroEmbedder, { minScore: threshold });
    return { name: `solo palabras ≥${threshold}`, retrieve: (q) => factKeys(book, q) };
  },
  /** Production: shared words plus a small wording-similarity term. */
  hybrid: (threshold: number): Retriever => {
    const book = loadBook(new HashedNgramEmbedder(), { minScore: threshold });
    return { name: `producción ≥${threshold}`, retrieve: (q) => factKeys(book, q) };
  },
};

export function evaluate(r: Retriever, queries: MemoryQuerySpec[]): MemoryEvalRow {
  let relevant = 0;
  let any = 0;
  let all = 0;
  let retrievedRel = 0;
  let okRel = 0;
  let none = 0;
  let falseInj = 0;
  let chars = 0;
  for (const q of queries) {
    const got = r.retrieve(q.q);
    chars += got.reduce((n, k) => n + (textOf.get(k)?.length ?? 0), 0);
    if (q.want.length === 0) {
      none++;
      if (got.length > 0) falseInj++;
      continue;
    }
    relevant++;
    if (q.want.some((k) => got.includes(k))) any++;
    if (q.want.every((k) => got.includes(k))) all++;
    retrievedRel += got.length;
    okRel += got.filter((k) => q.want.includes(k) || q.also?.includes(k)).length;
  }
  return {
    strategy: r.name,
    recallAny: relevant ? any / relevant : NaN,
    recallAll: relevant ? all / relevant : NaN,
    precision: retrievedRel ? okRel / retrievedRel : NaN,
    falseInjection: none ? falseInj / none : NaN,
    charsPerQuery: queries.length ? chars / queries.length : 0,
    relevantQueries: relevant,
    noneQueries: none,
  };
}

/** Alternate queries between "dev" (used to choose the threshold) and "test" (reported, never tuned on). */
export const split = (queries: MemoryQuerySpec[] = memoryQueries): { dev: MemoryQuerySpec[]; test: MemoryQuerySpec[] } => ({
  dev: queries.filter((_, i) => i % 2 === 0),
  test: queries.filter((_, i) => i % 2 === 1),
});

const pct = (x: number): string => (Number.isNaN(x) ? "—" : `${(x * 100).toFixed(0)}%`);

export function renderMemoryEval(rows: { label: string; rows: MemoryEvalRow[] }[]): string {
  const out: string[] = [];
  for (const g of rows) {
    out.push(`\n**${g.label}**\n`, "| Estrategia | Recupera ≥1 | Recupera todo | Precisión | Falsa inyección | Caracteres/consulta |", "|---|---|---|---|---|---|");
    for (const r of g.rows) out.push(`| ${r.strategy} | ${pct(r.recallAny)} | ${pct(r.recallAll)} | ${pct(r.precision)} | ${pct(r.falseInjection)} | ${r.charsPerQuery.toFixed(0)} |`);
  }
  return out.join("\n");
}

/**
 * Word-match scores are discrete (a framing word 0.3, a framing word in a question about the user 0.6, a topical word 0.85,
 * two clues 0.9+), so only thresholds BETWEEN those values change anything: 0.25 (any clue), 0.5 (personal framing word),
 * 0.7 (a topical word), 0.9 (two clues).
 */
export function runMemoryEval(thresholds: number[] = [0.25, 0.5, 0.7, 0.9]): string {
  const { dev, test } = split();
  const strategies = [retrievers.none(), retrievers.all(), retrievers.top3(), ...thresholds.flatMap((t) => [retrievers.embedding(t - 0.15), retrievers.lexical(t), retrievers.hybrid(t)])];
  const hard = (kind: MemoryQuerySpec["hard"]) => memoryQueries.filter((q) => q.hard === kind);
  const easy = memoryQueries.filter((q) => !q.hard);
  return renderMemoryEval([
    { label: `Desarrollo (${dev.length} consultas: se usa para elegir el umbral)`, rows: strategies.map((s) => evaluate(s, dev)) },
    { label: `Prueba retenida (${test.length} consultas: nunca se ajustó con ellas)`, rows: strategies.map((s) => evaluate(s, test)) },
    { label: `Solo consultas difíciles: huecos semánticos (${hard("semantic-gap").length}) y negativas difíciles (${hard("hard-negative").length})`, rows: [retrievers.hybrid(0.5), retrievers.embedding(0.35)].map((s) => evaluate(s, [...hard("semantic-gap"), ...hard("hard-negative")])) },
    { label: `Solo consultas normales (${easy.length})`, rows: [retrievers.hybrid(0.5), retrievers.lexical(0.5), retrievers.embedding(0.35)].map((s) => evaluate(s, easy)) },
  ]);
}
