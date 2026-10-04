import { describe, expect, it } from "vitest";
import type { ModelCapabilities, OrchestratorEvent } from "@jarvis/protocol";
import { PolicyEngine } from "@jarvis/policy";
import { FakeProvider, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry, filesRead, makeInstantForget, timeNow } from "@jarvis/tools";
import {
  EventBus, IntentRouter, MemoryInstantStore, MemoryTraceStore, Orchestrator, ResponseHeuristicEvaluator, RuleInstantResponder, SemanticCache,
  StaticRouter, instantControlRules, isCacheable, sameContent,
} from "../src";

describe("isCacheable (exclusion list)", () => {
  it("allows timeless factual and explanatory questions", () => {
    for (const q of ["cuál es la capital de Francia", "what is the speed of light", "explica qué es un closure en JavaScript", "tell me the difference between TCP and UDP"])
      expect(isCacheable(q), q).toEqual({ ok: true });
  });
  it("blocks anything time/state dependent, personal or contextual, tool-using, sensitive, code or oversized", () => {
    for (const q of [
      "qué tiempo hace hoy en Bogotá", "what is the latest news", "cuál es el precio del bitcoin", "cuál es mi contraseña es hunter2hunter2",
      "lee el archivo notas.txt", "arregla este bug en mi código", "explícame eso otra vez", "what is my name", "continue", "a".repeat(400),
      "mi clave es abc12345",
    ]) expect(isCacheable(q).ok, q).toBe(false);
  });
});

describe("sameContent (the guard against look-alike questions)", () => {
  it("accepts rewordings and rejects a different entity, number or intent", () => {
    expect(sameContent("cuál es la capital de Francia", "dime la capital de francia por favor")).toBe(true);
    expect(sameContent("cuál es la capital de Francia", "cuál es la capital de Italia")).toBe(false);
    expect(sameContent("cuánto es 17 por 23", "cuánto es 17 por 24")).toBe(false);
    expect(sameContent("cuánto es 17 por 23", "cuánto es 17 más 23")).toBe(false);
    expect(sameContent("what is the speed of light", "what is the speed of sound")).toBe(false);
  });
});

describe("SemanticCache", () => {
  const mk = (over: ConstructorParameters<typeof SemanticCache>[0] = {}, t = { now: 1_000 }) => ({ t, c: new SemanticCache({ now: () => t.now, ...over }) });

  it("serves only after minSeen verified answers, newest answer wins, hits are counted", () => {
    const { c } = mk();
    c.learn("cuál es la capital de Francia", "París (v1)");
    expect(c.lookup("dime la capital de Francia")).toBeUndefined(); // seen=1 < minSeen=2
    c.learn("dime la capital de francia", "París (v2)");
    const hit = c.lookup("capital de Francia por favor");
    expect(hit?.entry.response).toBe("París (v2)");
    expect(hit?.entry.hits).toBe(1);
    expect(c.list()).toHaveLength(1);
  });

  it("never serves a look-alike, a different language or an excluded question", () => {
    const { c } = mk({ minSeen: 1 });
    c.learn("cuál es la capital de Francia", "París");
    expect(c.lookup("cuál es la capital de Italia")).toBeUndefined();
    expect(c.lookup("what is the capital of France")).toBeUndefined();
    c.learn("qué tiempo hace hoy", "soleado");
    expect(c.list()).toHaveLength(1); // the volatile question was never stored
  });

  it("expires entries after the ttl and prunes the least recently used beyond maxEntries", () => {
    const { c, t } = mk({ minSeen: 1, ttlMs: 1_000, maxEntries: 2 });
    c.learn("cuál es la capital de Francia", "París");
    expect(c.lookup("cuál es la capital de Francia")).toBeDefined();
    t.now += 2_000;
    expect(c.lookup("cuál es la capital de Francia")).toBeUndefined();
    c.learn("what is the speed of light", "c");
    t.now += 1;
    c.learn("what is the capital of Japan", "Tokyo");
    t.now += 1;
    c.learn("explica qué es la fotosíntesis", "…");
    expect(c.list()).toHaveLength(2);
  });

  it("lets the user disable, inspect, forget by text and clear", () => {
    const { c } = mk({ minSeen: 1 });
    c.learn("cuál es la capital de Francia", "París");
    c.learn("what is the speed of light", "c");
    c.setEnabled(false);
    expect(c.lookup("cuál es la capital de Francia")).toBeUndefined();
    c.learn("what is the capital of Japan", "Tokyo");
    expect(c.list()).toHaveLength(2); // disabled: no learning either
    c.setEnabled(true);
    expect(c.forget("francia")).toBe(1);
    expect(c.lookup("cuál es la capital de Francia")).toBeUndefined();
    expect(c.clear()).toBe(1);
    expect(c.list()).toEqual([]);
  });

  it("ignores empty and oversized answers", () => {
    const { c } = mk({ minSeen: 1 });
    c.learn("cuál es la capital de Francia", "   ");
    c.learn("what is the speed of light", "x".repeat(3000));
    expect(c.list()).toEqual([]);
  });
});

const model: ModelCapabilities = {
  model: "m", provider: "fake", supportsVision: false, supportsTools: true, supportsStreaming: true,
  contextWindow: 10_000, estimatedInputCost: 0, estimatedOutputCost: 0, expectedLatency: 100, isLocal: false,
};

function setup(reply: (input: string) => string = () => "París es la capital de Francia.") {
  const bus = new EventBus();
  const events: OrchestratorEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const providers = new ProviderRegistry();
  const calls: string[] = [];
  providers.register(new FakeProvider("fake", [model], (req) => (calls.push(req.messages.at(-1)?.content ?? ""), reply(req.messages.at(-1)?.content ?? ""))));
  const cache = new SemanticCache({ store: new MemoryInstantStore() });
  const tools = new ToolRegistry().register(timeNow).register(filesRead).register(makeInstantForget(cache));
  const orch = new Orchestrator({
    bus, intents: new IntentRouter({ apps: {}, rules: instantControlRules }), router: new StaticRouter("m"), providers, tools,
    policy: new PolicyEngine(), askPermission: async () => true, traces: new MemoryTraceStore(),
    instant: new RuleInstantResponder(), cache, evaluators: [new ResponseHeuristicEvaluator()],
  });
  return { orch, events, calls, cache };
}

describe("Orchestrator + semantic cache", () => {
  it("learns from verified model answers and serves the third ask from cache with no model call", async () => {
    const { orch, events, calls, cache } = setup();
    await orch.run("cuál es la capital de Francia");
    await orch.run("dime la capital de Francia");
    expect(calls).toHaveLength(2);
    expect(cache.list()[0]).toMatchObject({ seen: 2, servable: true });

    events.length = 0;
    const trace = await orch.run("capital de francia por favor");
    expect(calls).toHaveLength(2); // no third model call
    expect(events.map((e) => e.type)).toEqual(["task.started", "intent.resolved", "instant.issued", "task.finished"]);
    expect(events.find((e) => e.type === "instant.issued")).toMatchObject({ kind: "cache", text: "París es la capital de Francia." });
    expect(trace).toMatchObject({ instant: "cache", usedLocalIntent: true, finalOutcome: "success", totalCostUsd: 0, attempts: [] });
  });

  it("does not serve or learn a different question", async () => {
    const { orch, calls } = setup();
    await orch.run("cuál es la capital de Francia");
    await orch.run("cuál es la capital de Francia");
    await orch.run("cuál es la capital de Italia");
    expect(calls).toHaveLength(3);
  });

  it("does not learn when the answer failed the evaluator", async () => {
    const { orch, cache } = setup(() => "");
    await orch.run("cuál es la capital de Francia");
    expect(cache.list()).toEqual([]);
  });

  it("does not learn an answer produced after a tool ran, even a read-only one the judge accepted", async () => {
    let step = 0;
    const bus = new EventBus();
    const cache = new SemanticCache({ store: new MemoryInstantStore() });
    const orch = new Orchestrator({
      bus, intents: new IntentRouter({ apps: {} }),
      router: new StaticRouter("m"),
      providers: new ProviderRegistry().register(
        new FakeProvider("fake", [model], () => (step++ % 2 === 0 ? { toolCalls: [{ id: "c", name: "time.now", args: {} }] } : "Son las diez de la noche en punto.")),
      ),
      tools: new ToolRegistry().register(timeNow), policy: new PolicyEngine(), askPermission: async () => true,
      traces: new MemoryTraceStore(), cache, evaluators: [new ResponseHeuristicEvaluator()],
    });
    const trace = await orch.run("explica cómo funciona un reloj de pared");
    expect(trace.finalOutcome).toBe("success");
    expect(step).toBe(2); // model -> tool -> model
    expect(cache.list()).toEqual([]);
  });

  it("is controllable from the user's own words, bypassing the model", async () => {
    const { orch, cache, events } = setup();
    cache.learn("what is the speed of light", "c");
    expect(cache.list()).toHaveLength(1);
    await orch.run("olvida la respuesta sobre speed of light");
    expect(cache.list()).toHaveLength(0);
    expect(events.some((e) => e.type === "task.error")).toBe(false);
  });
});
