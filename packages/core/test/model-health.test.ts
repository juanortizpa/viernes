import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@jarvis/protocol";
import { FakeProvider, ProviderError, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry } from "@jarvis/tools";
import { PolicyEngine } from "@jarvis/policy";
import { AlwaysCheapestRouter, EventBus, IntentRouter, MemoryTraceStore, ModelHealth, Orchestrator, ResponseHeuristicEvaluator } from "../src";

const cap = (model: string, price: number): ModelCapabilities => ({ model, provider: model, supportsVision: false, supportsTools: false, supportsStreaming: true, contextWindow: 10_000, estimatedInputCost: price, estimatedOutputCost: price, expectedLatency: 300, isLocal: false });

describe("ModelHealth (ADR-0029)", () => {
  it("cools a model down after a 429 (honouring Retry-After), backs off on repeats, and forgives on success", () => {
    let t = 0;
    const h = new ModelHealth({ now: () => t });
    h.record("a", { ok: false, status: 429 });
    expect(h.coolingDown("a")).toBe(true);
    t = 59_000;
    expect(h.coolingDown("a")).toBe(true);
    t = 61_000;
    expect(h.coolingDown("a")).toBe(false);
    h.record("a", { ok: false, status: 429 }); // second strike: 120 s
    t += 100_000;
    expect(h.coolingDown("a")).toBe(true);
    h.record("a", { ok: true, ttftMs: 200 });
    expect(h.coolingDown("a")).toBe(false);
    h.record("b", { ok: false, status: 429, retryAfterMs: 600_000 });
    t += 300_000;
    expect(h.coolingDown("b")).toBe(true);
    h.record("c", { ok: false, status: 400 }); // a bad request says nothing about availability
    expect(h.coolingDown("c")).toBe(false);
  });

  it("learns time to first token, and never leaves routing with no model", () => {
    const h = new ModelHealth();
    expect(h.expectedTtftMs({ model: "x", expectedLatency: 900 })).toBe(900);
    h.record("x", { ok: true, ttftMs: 100 });
    h.record("x", { ok: true, ttftMs: 200 });
    expect(h.expectedTtftMs({ model: "x", expectedLatency: 900 })).toBe(130);
    h.record("x", { ok: false, status: 503 });
    expect(h.available([cap("x", 0)]).map((c) => c.model)).toEqual(["x"]); // everything cooling: still try
  });

  it("the orchestrator skips a model that just refused, instead of waiting on it every time", async () => {
    const calls: string[] = [];
    const refuse = new FakeProvider("free", [cap("free", 0)], () => {
      calls.push("free");
      throw new ProviderError("HTTP 429: rate limited", "free", 429);
    });
    const good = new FakeProvider("good", [cap("good", 1)], () => (calls.push("good"), "París es la capital de Francia."));
    const health = new ModelHealth();
    const orch = new Orchestrator({
      bus: new EventBus(),
      intents: new IntentRouter({ apps: {} }),
      router: new AlwaysCheapestRouter(),
      providers: new ProviderRegistry().register(refuse).register(good),
      tools: new ToolRegistry(),
      policy: new PolicyEngine(),
      askPermission: async () => false,
      traces: new MemoryTraceStore(),
      evaluators: [new ResponseHeuristicEvaluator()],
      maxEscalations: 1,
      health,
    });
    await orch.run("¿cuál es la capital de Francia?");
    await orch.run("¿y la de Italia?");
    expect(calls).toEqual(["free", "good", "good"]); // the second request goes straight to the model that works
    expect(health.coolingDown("free")).toBe(true);
    expect(health.coolingDown("good")).toBe(false);
  });
});
