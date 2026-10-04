import { describe, expect, it } from "vitest";
import type { ModelCapabilities, OrchestratorEvent } from "@jarvis/protocol";
import { PolicyEngine } from "@jarvis/policy";
import { FakeProvider, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry, makeWebSearch } from "@jarvis/tools";
import { EventBus, FillerPolicy, IntentRouter, MemoryTraceStore, ModelHealth, Orchestrator, RuleInstantResponder, StaticRouter } from "../src";

const cls = { taskType: "qa_simple" as const, complexity: 0.2, needsTools: false };

describe("FillerPolicy (ADR-0029)", () => {
  it("stays quiet when the answer is predicted to be quick, and varies when it is not", () => {
    const f = new FillerPolicy();
    expect(f.receipt({ input: "¿qué es un closure?", cls, predictedMs: 400 })).toBeUndefined();
    const said = Array.from({ length: 6 }, () => f.receipt({ input: "¿qué es un closure?", cls, predictedMs: 1500 })!);
    expect(new Set(said).size).toBeGreaterThan(2);
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1]);
    expect(said.every((s) => s.split(" ").length <= 3)).toBe(true); // short: it is queued before the answer
    expect(f.receipt({ input: "creá un proyecto con tests", cls: { taskType: "agentic_project", complexity: 0.9, needsTools: true }, predictedMs: 3000 })).toMatch(/me pongo|lo armo|momento/);
  });

  it("describes what a slow tool is about to do, never a result", () => {
    const f = new FillerPolicy();
    expect(f.forTool("web.search", { query: "x" })).toMatch(/busco/i);
    expect(f.forTool("web.fetch", { url: "https://www.ambito.com/dolar" })).toBe("Leo ambito.com.");
    expect(f.forTool("code.agent", {})).toMatch(/agente/);
    expect(f.forTool("mcp.github.search", {})).toBe("Le pregunto a github.");
    expect(f.forTool("time.now", {})).toBeUndefined();
  });
});

const caps = (latency: number): ModelCapabilities => ({ model: "m", provider: "fake", supportsVision: false, supportsTools: true, supportsStreaming: true, contextWindow: 10_000, estimatedInputCost: 0, estimatedOutputCost: 0, expectedLatency: latency, isLocal: false });

function setup(latency: number, replies: (i: number) => unknown, health?: ModelHealth) {
  const events: OrchestratorEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  let i = 0;
  const fetch = async () => new Response('<div class="result results_links web-result "><a class="result__a" href="https://a.example/x">A</a></div>', { headers: { "content-type": "text/html" } });
  const orch = new Orchestrator({
    bus,
    intents: new IntentRouter({ apps: {} }),
    instant: new RuleInstantResponder(),
    router: new StaticRouter("m"),
    providers: new ProviderRegistry().register(new FakeProvider("fake", [caps(latency)], () => replies(i++) as never)),
    tools: new ToolRegistry().register(makeWebSearch({ fetch, lookup: async () => ["93.184.216.34"] })),
    policy: new PolicyEngine(),
    askPermission: async () => false,
    traces: new MemoryTraceStore(),
    fillers: new FillerPolicy(),
    ...(health ? { health } : {}),
  });
  const acks = () => events.filter((e): e is Extract<OrchestratorEvent, { type: "instant.issued" }> => e.type === "instant.issued").map((e) => e.text);
  return { orch, events, acks };
}

describe("fillers in a spoken conversation", () => {
  it("a slow model gets a receipt right after routing; a fast one gets none; text conversations keep the old acknowledgement rules", async () => {
    const slow = setup(1500, () => "París.");
    await slow.orch.run("¿cuál es la capital de Francia?", { modality: "voice" });
    expect(slow.acks()).toHaveLength(1);
    const types = slow.events.map((e) => e.type);
    expect(types.indexOf("instant.issued")).toBe(types.indexOf("route.decided") + 1);

    const fast = setup(200, () => "París.");
    await fast.orch.run("¿cuál es la capital de Francia?", { modality: "voice" });
    expect(fast.acks()).toEqual([]);

    const text = setup(1500, () => "París.");
    await text.orch.run("¿cuál es la capital de Francia?");
    expect(text.acks()).toEqual([]); // short question in text: no acknowledgement, as before
  });

  it("the learned latency, not the configured guess, decides", async () => {
    const health = new ModelHealth();
    for (let k = 0; k < 5; k++) health.record("m", { ok: true, ttftMs: 150 });
    const s = setup(3000, () => "París.", health);
    await s.orch.run("¿cuál es la capital de Francia?", { modality: "voice" });
    expect(s.acks()).toEqual([]);
  });

  it("the web search announces itself when it actually runs", async () => {
    const s = setup(200, (i) => (i === 0 ? { toolCalls: [{ id: "c", name: "web.search", args: { query: "dólar hoy" } }] } : "El dólar está a 1.560 según a.example."));
    await s.orch.run("¿a cuánto está el dólar hoy?", { modality: "voice" });
    const acks = s.acks();
    expect(acks.some((a) => /busco/i.test(a))).toBe(true);
    const ackAt = s.events.findIndex((e) => e.type === "instant.issued" && /busco/i.test(e.text));
    expect(s.events[ackAt - 1]?.type).toBe("tool.requested");
  });
});
