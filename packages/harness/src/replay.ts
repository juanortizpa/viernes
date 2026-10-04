import { shouldEscalate, type ModelCapabilities } from "@jarvis/protocol";
import {
  ResponseHeuristicEvaluator, escalationLadder, premiumModel, cheapestModel, routeRequestFor, type ModelRouter, type RouteRequest,
} from "@jarvis/core";
import type { CellTable } from "./table";
import type { Cell, EvalTask, PriceBook } from "./types";

/** Everything a policy may look at: complete cases only, so every policy is judged on exactly the same tasks. */
export interface ReplayData {
  tasks: EvalTask[];
  caps: ModelCapabilities[];
  cell(taskId: string, model: string): Cell;
  /** Cost of a cell under the active price book (tokens are the source of truth, prices are an assumption). */
  cost(c: Cell): number;
  prices: PriceBook;
}

export interface Replay {
  /** Ground truth of the answer finally delivered. */
  pass: boolean;
  costUsd: number;
  latencyMs: number;
  /** Models tried, in order. */
  path: string[];
}

export interface Policy {
  name: string;
  run(task: EvalTask, d: ReplayData): Replay;
}

export function buildReplayData(tasks: EvalTask[], models: ModelCapabilities[], table: CellTable, priceOverrides: PriceBook = {}): { data: ReplayData; dropped: string[] } {
  const complete = tasks.filter((t) => models.every((m) => table.hasResult(t.id, m.model)));
  const dropped = tasks.filter((t) => !complete.includes(t)).map((t) => t.id);
  const prices: PriceBook = Object.fromEntries(models.map((m) => [m.model, priceOverrides[m.model] ?? { input: m.estimatedInputCost, output: m.estimatedOutputCost }]));
  // Policies see the price book through the capabilities too, so routers order models by the same prices that cost them.
  const caps = models.map((m) => ({ ...m, estimatedInputCost: prices[m.model]!.input, estimatedOutputCost: prices[m.model]!.output }));
  return {
    dropped,
    data: {
      tasks: complete,
      caps,
      prices,
      cell: (taskId, model) => table.get(taskId, model)!,
      cost: (c) => (c.inputTokens * (prices[c.model]?.input ?? 0) + c.outputTokens * (prices[c.model]?.output ?? 0)) / 1_000_000,
    },
  };
}

const single = (c: Cell, d: ReplayData): Replay => ({ pass: c.pass, costUsd: d.cost(c), latencyMs: c.latencyMs, path: [c.model] });
const req = (t: EvalTask): RouteRequest => routeRequestFor(t.prompt);

/** Arms A and B: one fixed model for everything. */
export const fixedPolicy = (name: string, pick: (caps: ModelCapabilities[]) => ModelCapabilities | undefined): Policy => ({
  name,
  run(task, d) {
    const m = pick(d.caps);
    if (!m) throw new Error(`${name}: no model`);
    return single(d.cell(task.id, m.model), d);
  },
});
export const alwaysPremium = (): Policy => fixedPolicy("A_always_premium", premiumModel);
export const alwaysCheapest = (): Policy => fixedPolicy("B_always_cheapest", cheapestModel);

/** Any real `ModelRouter` (e.g. the production RulesRouter), used one-shot. */
export const routerPolicy = (name: string, router: ModelRouter): Policy => ({
  name,
  run(task, d) {
    const decision = router.route(req(task), d.caps);
    return single(d.cell(task.id, decision.model!), d);
  },
});

/** Decides, from a delivered answer, whether the cascade accepts it. */
export interface Judge {
  name: string;
  accepts(task: EvalTask, cell: Cell): boolean;
}

/** Perfect evaluator (knows ground truth): the upper bound of what any evaluator can do. */
export const oracleJudge: Judge = { name: "ground_truth", accepts: (_t, c) => c.pass };

/** The evaluator that actually ships: free response heuristics (ADR-0012). */
export function heuristicJudge(): Judge {
  const h = new ResponseHeuristicEvaluator();
  return {
    name: "heuristics",
    accepts: (task, cell) => {
      const taskType = routeRequestFor(task.prompt).taskType;
      return !shouldEscalate(h.evaluate({ input: task.prompt, taskType, response: cell.response }));
    },
  };
}

/** Cascade: start where the router says, climb the ladder while the judge rejects (ADR-0011). Costs of every attempt add up. */
export const cascadePolicy = (name: string, router: ModelRouter, judge: Judge, maxEscalations: number): Policy => ({
  name,
  run(task, d) {
    const r = req(task);
    const ladder = escalationLadder(r, d.caps);
    let model = router.route(r, d.caps).model!;
    const out: Replay = { pass: false, costUsd: 0, latencyMs: 0, path: [] };
    for (let step = 0; ; step++) {
      const c = d.cell(task.id, model);
      out.costUsd += d.cost(c);
      out.latencyMs += c.latencyMs;
      out.path.push(model);
      out.pass = c.pass;
      const next = ladder[ladder.findIndex((x) => x.model === model) + 1];
      if (judge.accepts(task, c) || step >= maxEscalations || !next) return out;
      model = next.model;
    }
  },
});

/** Hindsight upper bound: the cheapest model that actually solves the task (or the cheapest one if none does). */
export const oraclePolicy = (): Policy => ({
  name: "oracle",
  run(task, d) {
    const byPrice = [...d.caps].sort((a, b) => d.cost(d.cell(task.id, a.model)) - d.cost(d.cell(task.id, b.model)));
    const winner = byPrice.find((m) => d.cell(task.id, m.model).pass) ?? byPrice[0]!;
    return single(d.cell(task.id, winner.model), d);
  },
});

/**
 * Simplified stand-in for a RouteLLM-style learned router: per task type, pick the cheapest model whose TRAINING pass rate is within
 * `slack` of the best model's. Assignments for each task come from folds that exclude it (k-fold), so nothing is evaluated on its own labels.
 * It is not matrix factorisation over preference data; it only marks the "predict from features, no escalation" family (Phase 6 does the real one).
 */
export function crossValidatedPolicy(name: string, tasks: EvalTask[], d: ReplayData, opts: { folds?: number; slack?: number } = {}): Policy {
  const k = Math.max(2, Math.min(opts.folds ?? 5, tasks.length));
  const slack = opts.slack ?? 0.1;
  const type = (t: EvalTask) => routeRequestFor(t.prompt).taskType;
  const choice = new Map<string, string>();
  for (let f = 0; f < k; f++) {
    const train = tasks.filter((_, i) => i % k !== f);
    const byType = new Map<string, EvalTask[]>();
    for (const t of train) byType.set(type(t), [...(byType.get(type(t)) ?? []), t]);
    const strongest = premiumModel(d.caps)!;
    const pickFor = (ts: EvalTask[] | undefined): string => {
      if (!ts?.length) return strongest.model;
      const rate = (m: ModelCapabilities) => ts.filter((t) => d.cell(t.id, m.model).pass).length / ts.length;
      const best = Math.max(...d.caps.map(rate));
      const ok = d.caps.filter((m) => rate(m) >= best - slack);
      return [...ok].sort((a, b) => a.estimatedInputCost + a.estimatedOutputCost - (b.estimatedInputCost + b.estimatedOutputCost))[0]!.model;
    };
    tasks.forEach((t, i) => {
      if (i % k === f) choice.set(t.id, pickFor(byType.get(type(t))));
    });
  }
  return { name, run: (task, dd) => single(dd.cell(task.id, choice.get(task.id)!), dd) };
}
