import type { EconomySummary, ExecutionTrace } from "@jarvis/protocol";

const mean = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** Pure aggregation of traces for the AI Economy panel. */
export function summarizeEconomy(traces: readonly ExecutionTrace[]): EconomySummary {
  const byKind = { model: 0, local: 0, instant: 0, cache: 0 };
  const modelLat: number[] = [];
  const noLlmLat: number[] = [];
  const perModel = new Map<string, { tasks: number; costUsd: number }>();
  let ok = 0;
  let escalated = 0;
  let inTok = 0;
  let outTok = 0;
  let cost = 0;
  let baseline = 0;
  let saved = 0;

  for (const t of traces) {
    const kind = t.instant === "cache" ? "cache" : t.instant === "reply" ? "instant" : t.usedLocalIntent ? "local" : "model";
    byKind[kind]++;
    (kind === "model" ? modelLat : noLlmLat).push(t.totalLatencyMs);
    if (t.finalOutcome === "success") ok++;
    if (t.escalations > 0) escalated++;
    cost += t.totalCostUsd;
    for (const a of t.attempts) {
      inTok += a.usage.inputTokens;
      outTok += a.usage.outputTokens;
      const m = perModel.get(a.model) ?? { tasks: 0, costUsd: 0 };
      m.tasks++;
      m.costUsd += a.usage.estimatedCostUsd;
      perModel.set(a.model, m);
    }
    if (t.baselineCostUsd !== undefined) {
      baseline += t.baselineCostUsd;
      saved += t.baselineCostUsd - t.totalCostUsd;
    }
  }

  return {
    tasks: traces.length,
    byKind,
    successRate: traces.length ? ok / traces.length : 0,
    escalatedTasks: escalated,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: cost,
    baselineCostUsd: baseline,
    savedUsd: saved,
    savedPct: baseline > 0 ? saved / baseline : null,
    avgLatencyMs: { model: mean(modelLat), noLlm: mean(noLlmLat) },
    models: [...perModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.tasks - a.tasks)
      .slice(0, 5),
  };
}
