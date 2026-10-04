import { describe, expect, it } from "vitest";
import type { ModelCapabilities, OrchestratorEvent } from "@jarvis/protocol";
import { PolicyEngine } from "@jarvis/policy";
import { FakeProvider, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry, timeNow } from "@jarvis/tools";
import { EventBus, IntentRouter, MemoryTraceStore, Orchestrator, RuleInstantResponder, StaticRouter, classifyTask } from "../src";

const r = new RuleInstantResponder();

describe("RuleInstantResponder.reply", () => {
  it("answers pure pleasantries in the user's language, tolerating punctuation, accents, case and the assistant's name", () => {
    expect(r.reply("Hola")).toMatch(/Hola/);
    expect(r.reply("¡Hola, JARVIS!")).toMatch(/Hola/);
    expect(r.reply("hola, ¿cómo estás?")).toMatch(/Bien/);
    expect(r.reply("Buenos días")).toMatch(/Hola/);
    expect(r.reply("hello")).toBe("Hi! How can I help?");
    expect(r.reply("how are you?")).toMatch(/Doing well/);
    expect(r.reply("thanks")).toBe("You're welcome!");
    expect(r.reply("Muchas gracias")).toBe("¡De nada!");
    expect(r.reply("adiós")).toBe("¡Hasta luego!");
  });

  it("never captures a message that also asks for something, or anything time/state dependent", () => {
    for (const t of [
      "hola, abre vscode",
      "hola qué hora es",
      "hola, explícame qué es una promesa",
      "gracias, ahora crea un proyecto",
      "hello can you fix this bug",
      "buenos días, resume este archivo",
      "hola que tal el clima en bogota",
      "",
      "jarvis",
    ]) expect(r.reply(t), t).toBeUndefined();
  });
});

describe("RuleInstantResponder.ack", () => {
  const ack = (t: string) => r.ack(t, classifyTask(t));
  it("acknowledges long tasks only, in the task's language, without promising a result", () => {
    expect(ack("crea un proyecto de api con tests")).toBe("Entendido, me pongo con eso.");
    expect(ack("please analyze this stack trace and fix the bug")).toBe("Got it, I'm on it.");
    expect(ack("lee el archivo notas.txt")).toBeDefined();
    expect(ack("a".repeat(500))).toBeDefined();
    expect(ack("cuál es la capital de Francia")).toBeUndefined();
    expect(ack("explica qué es un closure")).toBeUndefined();
  });
});

const model: ModelCapabilities = {
  model: "slow", provider: "fake", supportsVision: false, supportsTools: false, supportsStreaming: true,
  contextWindow: 10_000, estimatedInputCost: 0, estimatedOutputCost: 0, expectedLatency: 100, isLocal: false,
};

function setup(withInstant = true) {
  const bus = new EventBus();
  const events: OrchestratorEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const traces = new MemoryTraceStore();
  const providers = new ProviderRegistry();
  const calls: string[] = [];
  providers.register(new FakeProvider("fake", [model], (req) => (calls.push(req.model), "respuesta del modelo")));
  const tools = new ToolRegistry();
  tools.register(timeNow);
  const orch = new Orchestrator({
    bus, intents: new IntentRouter({ apps: {} }), router: new StaticRouter("slow"), providers, tools,
    policy: new PolicyEngine(), askPermission: async () => true, traces,
    ...(withInstant ? { instant: new RuleInstantResponder() } : {}),
  });
  return { orch, events, traces, calls };
}

describe("Orchestrator + instant layer", () => {
  it("serves a pleasantry with no model call, as a valid local-route task with zero cost", async () => {
    const { orch, events, traces, calls } = setup();
    const trace = await orch.run("hola");
    expect(calls).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["task.started", "intent.resolved", "instant.issued", "task.finished"]);
    const issued = events.find((e) => e.type === "instant.issued");
    expect(issued).toMatchObject({ kind: "reply", text: "¡Hola! ¿En qué te puedo ayudar?" });
    expect(events.find((e) => e.type === "intent.resolved")).toMatchObject({ route: "local", intent: "instant.reply" });
    expect(trace).toMatchObject({ instant: "reply", usedLocalIntent: true, finalOutcome: "success", totalCostUsd: 0, attempts: [] });
    expect(traces.traces[0]?.instant).toBe("reply");
  });

  it("acknowledges a long task BEFORE routing or any model output, then still runs the model", async () => {
    const { orch, events, calls } = setup();
    const trace = await orch.run("crea un proyecto de api con tests");
    const types = events.map((e) => e.type);
    expect(types.indexOf("instant.issued")).toBeGreaterThan(-1);
    expect(types.indexOf("instant.issued")).toBeLessThan(types.indexOf("route.decided"));
    expect(types.indexOf("instant.issued")).toBeLessThan(types.indexOf("response.delta"));
    expect(events.find((e) => e.type === "instant.issued")).toMatchObject({ kind: "ack" });
    expect(calls).toEqual(["slow"]);
    expect(trace.instant).toBe("ack");
    expect(trace.attempts).toHaveLength(1);
  });

  it("does not interfere with local intents or short model questions", async () => {
    const { orch, events, calls } = setup();
    await orch.run("qué hora es");
    expect(events.some((e) => e.type === "instant.issued")).toBe(false);
    events.length = 0;
    await orch.run("cuál es la capital de Francia");
    expect(events.some((e) => e.type === "instant.issued")).toBe(false);
    expect(calls).toEqual(["slow"]);
  });

  it("does nothing when no instant responder is configured", async () => {
    const { orch, events, calls } = setup(false);
    await orch.run("hola");
    expect(events.some((e) => e.type === "instant.issued")).toBe(false);
    expect(calls).toEqual(["slow"]);
  });
});
