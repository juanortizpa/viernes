import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "@jarvis/protocol";
import type { EventBody as Body } from "../demo/scenarios";
import { initialState, islandReducer, type IslandState } from "./island";

let n = 0;
const ev = (body: Body): OrchestratorEvent => ({ id: `e${n}`, taskId: "t", seq: n++, ts: n, ...body }) as OrchestratorEvent;
const run = (events: Body[], from: IslandState = initialState) =>
  events.reduce((s, b) => islandReducer(s, { kind: "event", event: ev(b) }), from);

describe("islandReducer", () => {
  it("local intent shows zero tokens and ends in success", () => {
    const s = run([
      { type: "task.started", input: "abre vscode", modality: "text" },
      { type: "intent.resolved", route: "local", intent: "open_application", confidence: 0.98 },
      { type: "task.finished", outcome: "success" },
    ]);
    expect(s.mode).toBe("success");
    expect(s.route).toBe("local");
    expect(s.tokens).toBe(0);
    expect(s.costUsd).toBe(0);
  });

  it("permission request sets pending and mode; denial warns and clears it", () => {
    const asked = run([
      { type: "task.started", input: "x", modality: "text" },
      { type: "permission.required", requestId: "r1", tool: "run_command", risk: "sensitive", reason: "edita archivos" },
    ]);
    expect(asked.mode).toBe("permission");
    expect(asked.pending?.requestId).toBe("r1");
    const denied = run([{ type: "permission.resolved", requestId: "r1", granted: false }], asked);
    expect(denied.mode).toBe("warning");
    expect(denied.pending).toBeUndefined();
  });

  it("accumulates usage and counts escalations", () => {
    const usage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, estimatedCostUsd: 0.01, latencyMs: 500 };
    const s = run([
      { type: "task.started", input: "x", modality: "text" },
      { type: "model.completed", model: "a", usage },
      { type: "escalated", from: "a", to: "b", reason: "tests failed" },
      { type: "model.completed", model: "b", usage },
    ]);
    expect(s.tokens).toBe(300);
    expect(s.costUsd).toBeCloseTo(0.02);
    expect(s.escalations).toBe(1);
    expect(s.model).toBe("b");
  });

  it("only shows a progress fraction when an event provided one", () => {
    const none = run([{ type: "task.started", input: "x", modality: "text" }, { type: "progress", stage: "indexando" }]);
    expect(none.fraction).toBeUndefined();
    const some = run([{ type: "progress", stage: "indexando", fraction: 0.4 }], none);
    expect(some.fraction).toBe(0.4);
  });

  it("reset returns to idle", () => {
    expect(islandReducer({ ...initialState, mode: "error" }, { kind: "reset" })).toEqual(initialState);
  });
});
