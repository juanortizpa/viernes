import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@jarvis/protocol";
import { PolicyEngine } from "@jarvis/policy";
import { FakeProvider, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry } from "@jarvis/tools";
import { EventBus, IntentRouter, MemoryTraceStore, Orchestrator, RulesRouter, estimateCostUsd } from "../src";

const cap = (model: string, inCost: number, outCost: number): ModelCapabilities => ({
  model, provider: "fake", supportsVision: false, supportsTools: false, supportsStreaming: true,
  contextWindow: 100_000, estimatedInputCost: inCost, estimatedOutputCost: outCost, expectedLatency: 1, isLocal: false,
});

describe("routing inside the orchestrator", () => {
  it("classifies the task, routes by rules, and records the always-premium baseline", async () => {
    const cheap = cap("cheap", 0.15, 0.6);
    const premium = cap("premium", 5, 15);
    const traces = new MemoryTraceStore();
    const orch = new Orchestrator({
      bus: new EventBus(),
      intents: new IntentRouter({ apps: {} }),
      router: new RulesRouter(),
      providers: new ProviderRegistry().register(new FakeProvider("fake", [cheap, premium], () => "respuesta")),
      tools: new ToolRegistry(),
      policy: new PolicyEngine(),
      askPermission: async () => false,
      traces,
    });

    const easy = await orch.run("¿Qué es un átomo?");
    expect(easy.taskType).toBe("qa_simple");
    expect(easy.attempts[0]?.model).toBe("cheap");
    const usage = easy.attempts[0]!.usage;
    expect(easy.baselineCostUsd).toBeCloseTo(estimateCostUsd(premium, usage));
    expect(easy.baselineCostUsd!).toBeGreaterThanOrEqual(easy.totalCostUsd);

    const hard = await orch.run("depura este crash: Traceback (most recent call last)");
    expect(hard.taskType).toBe("debugging");
    expect(hard.attempts[0]?.model).toBe("premium");
    expect(hard.attempts[0]?.decision.strategy).toBe("rules_v1");
  });
});
