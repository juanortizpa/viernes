import { describe, expect, it } from "vitest";
import {
  ExecutionTrace,
  ModelCapabilities,
  OrchestratorEvent,
  RoutingDecision,
  compareRisk,
  shouldEscalate,
} from "../src";

const base = { id: "e1", taskId: "t1", seq: 0, ts: 1 };

describe("OrchestratorEvent", () => {
  it("accepts a valid event and rejects unknown types", () => {
    expect(OrchestratorEvent.safeParse({ ...base, type: "task.started", input: "hi", modality: "text" }).success).toBe(true);
    expect(OrchestratorEvent.safeParse({ ...base, type: "made.up" }).success).toBe(false);
  });

  it("rejects progress fractions outside 0..1", () => {
    const bad = { ...base, type: "progress", stage: "x", fraction: 1.5 };
    expect(OrchestratorEvent.safeParse(bad).success).toBe(false);
  });
});

describe("RoutingDecision", () => {
  it("requires a propensity", () => {
    const d = { kind: "model", strategy: "rules_v1", taskType: "coding", complexity: 0.4, rationale: "r" };
    expect(RoutingDecision.safeParse(d).success).toBe(false);
    expect(RoutingDecision.safeParse({ ...d, propensity: 1 }).success).toBe(true);
  });
});

describe("ModelCapabilities", () => {
  it("defaults isLocal to false", () => {
    const m = ModelCapabilities.parse({
      model: "m", provider: "p", supportsVision: false, supportsTools: true, supportsStreaming: true,
      contextWindow: 1000, estimatedInputCost: 1, estimatedOutputCost: 2, expectedLatency: 300,
    });
    expect(m.isLocal).toBe(false);
  });
});

describe("shouldEscalate", () => {
  const v = (outcome: "success" | "failure" | "uncertain", confidence: number) => ({
    evaluator: "t", outcome, confidence, evidence: "",
  });
  it("escalates on failure and on low-confidence uncertain, never treats uncertain as success", () => {
    expect(shouldEscalate(v("failure", 0.99))).toBe(true);
    expect(shouldEscalate(v("uncertain", 0.5))).toBe(true);
    expect(shouldEscalate(v("uncertain", 0.9))).toBe(false);
    expect(shouldEscalate(v("success", 0.1))).toBe(false);
  });
});

describe("risk ordering and trace", () => {
  it("orders permission levels", () => {
    expect(compareRisk("critical", "read")).toBeGreaterThan(0);
    expect(compareRisk("read", "reversible")).toBeLessThan(0);
  });
  it("validates a local-intent trace with zero attempts", () => {
    const t = ExecutionTrace.safeParse({
      taskId: "t", startedAt: 1, taskType: "local_action", inputTokensEstimate: 4, usedLocalIntent: true,
      attempts: [], escalations: 0, finalOutcome: "success", totalCostUsd: 0, totalLatencyMs: 40,
    });
    expect(t.success).toBe(true);
  });
});
