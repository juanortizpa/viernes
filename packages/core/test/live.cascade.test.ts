import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ModelCapabilities, OrchestratorEvent, Verdict } from "@jarvis/protocol";
import { PolicyEngine } from "@jarvis/policy";
import { OpenRouterProvider, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry } from "@jarvis/tools";
import { AlwaysCheapestRouter, EventBus, IntentRouter, MemoryTraceStore, Orchestrator, ResponseHeuristicEvaluator, type Evaluator } from "../src";

const key = process.env.JARVIS_LIVE ? process.env.OPENROUTER_API_KEY : undefined;
const free: ModelCapabilities[] = JSON.parse(readFileSync(new URL("../../../jarvis.config.free.example.json", import.meta.url), "utf8")).openrouter.models;

function build(models: ModelCapabilities[], evaluators: Evaluator[]) {
  const events: OrchestratorEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  const orch = new Orchestrator({
    bus,
    intents: new IntentRouter({ apps: {} }),
    router: new AlwaysCheapestRouter(),
    providers: new ProviderRegistry().register(new OpenRouterProvider({ apiKey: key!, models })),
    tools: new ToolRegistry(),
    policy: new PolicyEngine(),
    askPermission: async () => false,
    traces: new MemoryTraceStore(),
    evaluators,
    maxEscalations: 2,
  });
  return { orch, events };
}

/** Real network, free models only. Run with JARVIS_LIVE=1 OPENROUTER_API_KEY=… NODE_USE_ENV_PROXY=1 (if behind a proxy). */
describe.skipIf(!key)("cascade — live free models", () => {
  it("escalates on a real provider error (unknown model id -> 404) and answers with the next model", async () => {
    const broken: ModelCapabilities = { ...free[0]!, model: "jarvis-test/does-not-exist:free" };
    const { orch, events } = build([broken, ...free.slice(1)], [new ResponseHeuristicEvaluator()]);
    const t = await orch.run("¿Cuál es la capital de Francia?");
    console.log(events.flatMap((e) => (e.type === "escalated" ? [`${e.from} -> ${e.to}: ${e.reason.slice(0, 90)}`] : [])), t.finalOutcome);
    // The free tier is rate limited at times, so more than one hop is legitimate; what matters is that the cascade recovers.
    expect(t.attempts[0]!.model).toBe(broken.model);
    expect(t.escalations).toBeGreaterThanOrEqual(1);
    expect(t.escalations).toBeLessThanOrEqual(2);
    expect(t.finalOutcome).toBe("success");
    expect(t.totalCostUsd).toBe(0);
  }, 90_000);

  it("escalates on a failed verdict after a real answer and keeps cost at zero", async () => {
    let calls = 0;
    const strict: Evaluator = {
      name: "strict_once",
      evaluate: (): Verdict => ({ evaluator: "strict_once", outcome: calls++ === 0 ? "failure" : "success", confidence: 1, evidence: calls === 1 ? "forced failure" : "ok" }),
    };
    const { orch } = build(free, [strict]);
    const t = await orch.run("Responde solo con la palabra: hola");
    console.log(t.attempts.map((a) => [a.model, a.verdict?.outcome, a.usage.outputTokens]));
    expect(t.attempts[0]!.verdict?.outcome).toBe("failure");
    expect(t.attempts[1]!.model).not.toBe(t.attempts[0]!.model);
    expect(t.escalations).toBeGreaterThanOrEqual(1);
    expect(t.finalOutcome).toBe("success");
    expect(t.totalCostUsd).toBe(0);
  }, 120_000);
});
