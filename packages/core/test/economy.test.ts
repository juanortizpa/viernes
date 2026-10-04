import { describe, expect, it } from "vitest";
import type { ExecutionTrace } from "@jarvis/protocol";
import { MemoryTraceStore, summarizeEconomy } from "../src";

const usage = (i: number, o: number, c: number) => ({ inputTokens: i, outputTokens: o, cachedInputTokens: 0, estimatedCostUsd: c, latencyMs: 1 });
const decision = { kind: "model" as const, model: "m", strategy: "s", taskType: "other" as const, complexity: 0, candidates: [], propensity: 1, explored: false, rationale: "" };
const base: ExecutionTrace = { taskId: "t", startedAt: 1, taskType: "other", inputTokensEstimate: 1, usedLocalIntent: false, attempts: [], escalations: 0, finalOutcome: "success", userIntervened: false, totalCostUsd: 0, totalLatencyMs: 1000 };
const model = (id: string, cost: number, baseline: number | undefined, over: Partial<ExecutionTrace> = {}): ExecutionTrace => ({
  ...base, taskId: id, totalCostUsd: cost, baselineCostUsd: baseline,
  attempts: [{ model: "cheap", provider: "p", decision, usage: usage(100, 50, cost) }], ...over,
});

describe("summarizeEconomy", () => {
  it("classifies how each task was answered and measures savings only where a baseline exists", () => {
    const s = summarizeEconomy([
      model("a", 0.001, 0.01),
      model("b", 0.003, 0.01, { escalations: 1, finalOutcome: "failure" }),
      { ...base, taskId: "l", usedLocalIntent: true, totalLatencyMs: 10 },
      { ...base, taskId: "i", usedLocalIntent: true, instant: "reply", totalLatencyMs: 2 },
      { ...base, taskId: "c", usedLocalIntent: true, instant: "cache", totalLatencyMs: 4 },
      model("ack", 0.002, undefined, { instant: "ack" }), // acknowledged, then a model answered: still a model task
    ]);
    expect(s.byKind).toEqual({ model: 3, local: 1, instant: 1, cache: 1 });
    expect(s.tasks).toBe(6);
    expect(s.successRate).toBeCloseTo(5 / 6);
    expect(s.escalatedTasks).toBe(1);
    expect(s.costUsd).toBeCloseTo(0.006);
    expect(s.baselineCostUsd).toBeCloseTo(0.02); // the task with no baseline is excluded from both sides
    expect(s.savedUsd).toBeCloseTo(0.016);
    expect(s.savedPct).toBeCloseTo(0.8);
    expect(s.inputTokens).toBe(300);
    expect(s.avgLatencyMs).toEqual({ model: 1000, noLlm: 5 });
    expect(s.models).toEqual([{ model: "cheap", tasks: 3, costUsd: expect.closeTo(0.006) }]);
  });

  it("claims no percentage when nothing was priced, and handles an empty history", () => {
    expect(summarizeEconomy([model("a", 0, 0)]).savedPct).toBeNull();
    const e = summarizeEconomy([]);
    expect(e).toMatchObject({ tasks: 0, successRate: 0, savedPct: null, avgLatencyMs: { model: null, noLlm: null } });
  });

  it("MemoryTraceStore lists most recent first", () => {
    const s = new MemoryTraceStore();
    s.save({ ...base, taskId: "1" });
    s.save({ ...base, taskId: "2" });
    expect(s.list(1).map((t) => t.taskId)).toEqual(["2"]);
  });
});
