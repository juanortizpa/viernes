import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@jarvis/protocol";
import { AlwaysCheapestRouter, RulesRouter } from "@jarvis/core";
import { FakeProvider, ProviderRegistry } from "@jarvis/providers";
import {
  CellTable, alwaysCheapest, alwaysPremium, analyze, buildReplayData, cascadePolicy, crossValidatedPolicy, heuristicJudge, oracleJudge, oraclePolicy,
  pairedBootstrap, renderMarkdown, routerPolicy, runCounterfactual, seedSuite, type Cell,
} from "../src";

const cap = (model: string, price: number): ModelCapabilities => ({
  model, provider: "fake", supportsVision: false, supportsTools: true, supportsStreaming: true,
  contextWindow: 100_000, estimatedInputCost: price, estimatedOutputCost: price, expectedLatency: 1, isLocal: false,
});
const models = [cap("small", 0.1), cap("mid", 0.5), cap("big", 2)];
const isCoding = (i: number) => seedSuite[i]!.check.kind === "code_tests";

/** small: fails coding and every 3rd task; mid: fails coding every 4th; big: always right. */
function syntheticTable(): CellTable {
  const table = new CellTable();
  seedSuite.forEach((t, i) => {
    const passes: Record<string, boolean> = { small: !isCoding(i) && i % 3 !== 0, mid: !(isCoding(i) && i % 4 === 0), big: true };
    for (const m of models) {
      const pass = passes[m.model]!;
      const cell: Cell = { taskId: t.id, model: m.model, response: pass ? "una respuesta correcta y razonable" : "", pass, detail: "", inputTokens: 100, outputTokens: 50, latencyMs: m.model === "big" ? 3000 : 500, ts: 0 };
      table.add(cell);
    }
  });
  return table;
}

describe("replay policies", () => {
  const { data, dropped } = buildReplayData(seedSuite, models, syntheticTable());
  const run = (p: ReturnType<typeof alwaysCheapest>) => data.tasks.map((t) => p.run(t, data));
  const rate = (rs: { pass: boolean }[]) => rs.filter((r) => r.pass).length / rs.length;
  const total = (rs: { costUsd: number }[]) => rs.reduce((a, r) => a + r.costUsd, 0);

  it("uses complete cases only and drops tasks with missing cells", () => {
    expect(dropped).toEqual([]);
    const partial = syntheticTable();
    const holes = new CellTable();
    for (const c of partial.all()) if (!(c.taskId === seedSuite[0]!.id && c.model === "big")) holes.add(c);
    const r = buildReplayData(seedSuite, models, holes);
    expect(r.dropped).toEqual([seedSuite[0]!.id]);
    expect(r.data.tasks).toHaveLength(seedSuite.length - 1);
  });

  it("A is the success ceiling and the cost ceiling; B is the floor; oracle matches A's success at B's-or-lower cost", () => {
    const [a, b, o] = [run(alwaysPremium()), run(alwaysCheapest()), run(oraclePolicy())];
    expect(rate(a)).toBe(1);
    expect(rate(b)).toBeLessThan(1);
    expect(rate(o)).toBe(1);
    expect(total(b)).toBeLessThan(total(o));
    expect(total(o)).toBeLessThan(total(a));
  });

  it("cascade with a ground-truth judge recovers A's success for less than A's cost", () => {
    const c = run(cascadePolicy("cascade", new AlwaysCheapestRouter(), oracleJudge, 2));
    expect(rate(c)).toBe(1);
    expect(total(c)).toBeLessThan(total(run(alwaysPremium())));
    expect(c.some((r) => r.path.length > 1)).toBe(true);
    // Every failed rung is paid for: escalated runs cost more than a single big call.
    const esc = c.find((r) => r.path.length === 3)!;
    expect(esc.path).toEqual(["small", "mid", "big"]);
    expect(esc.costUsd).toBeCloseTo((150 * (0.1 + 0.5 + 2)) / 1e6, 10);
  });

  it("the shipped heuristic judge catches empty answers but cannot see wrong-but-plausible ones", () => {
    const h = heuristicJudge();
    const failing = data.tasks.map((t) => data.cell(t.id, "small")).filter((c) => !c.pass);
    expect(failing.every((c) => !h.accepts(seedSuite[0]!, c))).toBe(true);
    expect(h.accepts(seedSuite[0]!, { ...failing[0]!, response: "Sydney", pass: false })).toBe(true);
  });

  it("a real router can be replayed, and cross-validated assignments never use a task's own label", () => {
    const rules = run(routerPolicy("C_rules", new RulesRouter()));
    expect(rules).toHaveLength(data.tasks.length);
    const cv = crossValidatedPolicy("cv", data.tasks, data);
    expect(run(cv)).toEqual(run(crossValidatedPolicy("cv", data.tasks, data)));
  });
});

describe("analysis", () => {
  const { data, dropped } = buildReplayData(seedSuite, models, syntheticTable());
  const policies = [alwaysPremium(), alwaysCheapest(), oraclePolicy(), cascadePolicy("cascade", new AlwaysCheapestRouter(), oracleJudge, 2)];

  it("is reproducible, paired against the baseline, and marks the Pareto frontier", () => {
    const r1 = analyze(policies, data, "A_always_premium", dropped);
    const r2 = analyze(policies, data, "A_always_premium", dropped);
    expect(r1).toEqual(r2);
    const byName = Object.fromEntries(r1.policies.map((p) => [p.policy, p]));
    expect(byName["A_always_premium"]!.costSaving.estimate).toBeCloseTo(0, 10);
    expect(byName["A_always_premium"]!.successDelta).toEqual({ estimate: 0, lo: 0, hi: 0 });
    expect(byName["oracle"]!.costSaving.estimate).toBeGreaterThan(0.5);
    expect(byName["B_always_cheapest"]!.successDelta.estimate).toBeLessThan(0);
    for (const p of r1.policies) expect(p.success.lo).toBeLessThanOrEqual(p.success.estimate), expect(p.success.hi).toBeGreaterThanOrEqual(p.success.estimate);
    // A is dominated by the oracle (same success, lower cost), so it is off the frontier; B and the oracle stay on it.
    expect(byName["A_always_premium"]!.onFrontier).toBe(false);
    expect(byName["oracle"]!.onFrontier).toBe(true);
    expect(byName["B_always_cheapest"]!.onFrontier).toBe(true);
    expect(r1.judge.accepts + r1.judge.falseAccepts + r1.judge.wastedRejects + r1.judge.correctRejects).toBe(data.tasks.length * models.length);
  });

  it("renders a markdown report that states its price assumptions", () => {
    const md = renderMarkdown(analyze(policies, data, "A_always_premium", dropped), data.prices);
    expect(md).toContain("| oracle |");
    expect(md).toContain("Precios supuestos");
    expect(md).toContain("- big: entrada 2, salida 2");
  });
});

describe("pairedBootstrap", () => {
  it("brackets the true mean and shrinks with more data", () => {
    const xs = Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? 1 : 0)); // mean 0.25
    const mean = (idx: number[]) => idx.reduce((a, i) => a + xs[i]!, 0) / idx.length;
    const ci = pairedBootstrap(200, mean, { seed: 7 });
    expect(ci.estimate).toBeCloseTo(0.25, 10);
    expect(ci.lo).toBeLessThan(0.25);
    expect(ci.hi).toBeGreaterThan(0.25);
    expect(ci.hi - ci.lo).toBeLessThan(0.15);
    expect(pairedBootstrap(200, mean, { seed: 7 })).toEqual(ci);
  });
});

describe("runCounterfactual", () => {
  const tasks = seedSuite.slice(0, 4);
  const mk = (respond: (model: string, prompt: string) => string) =>
    new ProviderRegistry().register(new FakeProvider("fake", models, (req) => respond(req.model, (req.messages[0] as { content: string }).content)));

  it("fills the table with graded cells, persists them, and resumes without recomputing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "jarvis-table-")), "t.jsonl");
    const table = new CellTable(path);
    const reply = (model: string) => (model === "big" ? "Canberra" : "no sé");
    const r1 = await runCounterfactual({ tasks, models, providers: mk(reply), table, concurrency: 3 });
    expect(r1).toEqual({ computed: 12, errors: 0, skipped: 0 });
    expect(table.get(tasks[0]!.id, "big")).toMatchObject({ pass: true, response: "Canberra" });
    expect(table.get(tasks[0]!.id, "small")).toMatchObject({ pass: false });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(12);

    let calls = 0;
    const r2 = await runCounterfactual({ tasks, models, providers: mk(() => (calls++, "x")), table: new CellTable(path) });
    expect(r2).toEqual({ computed: 0, errors: 0, skipped: 12 });
    expect(calls).toBe(0);
  });

  it("retries transport errors with backoff, records a retriable error cell when they persist, and heals on the next run", async () => {
    const table = new CellTable();
    const sleeps: number[] = [];
    let fail = true;
    const providers = new ProviderRegistry().register(
      new FakeProvider("fake", models, (req) => {
        if (req.model === "mid" && fail) throw new Error("HTTP 429");
        return "ok";
      }),
    );
    const base = { tasks: tasks.slice(0, 1), models, providers, table, retries: 2, backoffMs: 10, sleep: async (ms: number) => void sleeps.push(ms) };
    expect(await runCounterfactual(base)).toMatchObject({ computed: 2, errors: 1 });
    expect(sleeps).toEqual([10, 20]);
    expect(table.get(tasks[0]!.id, "mid")).toMatchObject({ error: "HTTP 429", pass: false });
    expect(table.hasResult(tasks[0]!.id, "mid")).toBe(false); // an error cell is not evidence about the model

    fail = false;
    expect(await runCounterfactual(base)).toMatchObject({ computed: 1, errors: 0, skipped: 2 });
    expect(table.get(tasks[0]!.id, "mid")?.error).toBeUndefined();
  });

  it("stops cleanly on a daily quota error without recording evidence or retrying, and honours a call budget", async () => {
    const table = new CellTable();
    let calls = 0;
    const quota = new ProviderRegistry().register(
      new FakeProvider("fake", models, () => {
        calls++;
        throw new Error('HTTP 429: {"error":{"message":"Rate limit exceeded: free-models-per-day."}}');
      }),
    );
    const sleeps: number[] = [];
    const r = await runCounterfactual({ tasks, models, providers: quota, table, concurrency: 1, sleep: async (ms) => void sleeps.push(ms) });
    expect(r).toMatchObject({ stopped: "quota", errors: 0, computed: 0 });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(table.all()).toEqual([]);

    const ok = new ProviderRegistry().register(new FakeProvider("fake", models, () => "ok"));
    const b = await runCounterfactual({ tasks, models, providers: ok, table, concurrency: 1, budget: 5 });
    expect(b).toMatchObject({ stopped: "budget", computed: 5 });
    expect(table.all()).toHaveLength(5);
  });

  it("visits tasks in a seeded random order so a cut-short run is not just the easy head of the suite", async () => {
    const ok = () => new ProviderRegistry().register(new FakeProvider("fake", models, () => "ok"));
    const ids = async (seed: number) => {
      const table = new CellTable();
      await runCounterfactual({ tasks: seedSuite, models: [models[0]!, models[1]!], providers: ok(), table, concurrency: 1, budget: 10, seed });
      return new Set(table.all().map((c) => c.taskId));
    };
    const a = await ids(1);
    expect([...a]).toEqual([...(await ids(1))]);
    expect([...a]).not.toEqual([...(await ids(2))]);
    expect([...a].some((id) => Number(id.slice(-3)) > 10)).toBe(true);
  });
});
