import { describe, expect, it } from "vitest";
import { evaluate, retrievers, split } from "../src/memory-eval";
import { memoryFacts, memoryQueries } from "../src/suites/memory-corpus";

const production = () => retrievers.hybrid(0.55);

describe("memory corpus", () => {
  it("is well formed: every wanted key exists, queries are unique, and every fact is accepted by the book", () => {
    const keys = new Set(memoryFacts.map((f) => f.key));
    expect(keys.size).toBe(memoryFacts.length);
    for (const q of memoryQueries) for (const k of [...q.want, ...(q.also ?? [])]) expect(keys.has(k), `${q.q} -> ${k}`).toBe(true);
    expect(new Set(memoryQueries.map((q) => q.q)).size).toBe(memoryQueries.length);
    expect(production().retrieve("cómo se llama mi gato")).toEqual(["gato"]); // loads the corpus through MemoryBook.add (throws if refused)
  });
});

describe("memory retrieval quality (regression bounds, measured with `harness memory-eval`)", () => {
  const easy = memoryQueries.filter((q) => !q.hard);
  const { dev, test } = split();

  it("ordinary questions: finds what is relevant and almost never injects what is not", () => {
    const r = evaluate(production(), easy);
    expect(r.recallAny).toBeGreaterThanOrEqual(0.95);
    expect(r.precision).toBeGreaterThanOrEqual(0.85);
    expect(r.falseInjection).toBeLessThanOrEqual(0.1);
  });

  it("holds on both halves of the corpus, including the hard cases (which are expected to cost some precision)", () => {
    for (const half of [dev, test]) {
      const r = evaluate(production(), half);
      expect(r.recallAny).toBeGreaterThanOrEqual(0.85);
      expect(r.falseInjection).toBeLessThanOrEqual(0.25);
      expect(r.charsPerQuery).toBeLessThan(80); // vs ~1400 for putting every memory in every prompt
    }
  });

  it("beats every cheap alternative it is compared against", () => {
    const all = memoryQueries;
    const mine = evaluate(production(), all);
    const embedding = evaluate(retrievers.embedding(0.35), all);
    const stuffAll = evaluate(retrievers.all(), all);
    const top3 = evaluate(retrievers.top3(), all);
    expect(mine.recallAny).toBeGreaterThan(embedding.recallAny + 0.3); // wording similarity alone misses most relevant memories
    expect(mine.charsPerQuery).toBeLessThan(stuffAll.charsPerQuery / 10);
    expect(mine.falseInjection).toBeLessThan(top3.falseInjection / 3); // "best 3 whatever the score" injects something every time
  });

  it("is honest about the semantic gap: with no shared word it does not find the memory", () => {
    const gaps = memoryQueries.filter((q) => q.hard === "semantic-gap");
    expect(evaluate(production(), gaps).recallAny).toBeLessThanOrEqual(0.5);
  });
});
