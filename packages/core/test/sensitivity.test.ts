import { describe, expect, it } from "vitest";
import type { ModelCapabilities, OrchestratorEvent } from "@jarvis/protocol";
import { PolicyEngine } from "@jarvis/policy";
import { FakeProvider, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry } from "@jarvis/tools";
import { AlwaysCheapestRouter, EventBus, IntentRouter, MemoryTraceStore, Orchestrator, classifyTask, detectSensitive } from "../src";

describe("detectSensitive", () => {
  it("flags credentials and financial identifiers without echoing them", () => {
    expect(detectSensitive("mi clave es hunter2!!").reasons).toEqual(["password"]);
    expect(detectSensitive("usa sk-abcdefghijklmnopqrstuvwx para entrar").reasons).toEqual(["api key"]);
    expect(detectSensitive("-----BEGIN RSA PRIVATE KEY-----\nabc").reasons).toEqual(["private key"]);
    expect(detectSensitive("tarjeta 4111 1111 1111 1111 caduca").reasons).toEqual(["card number"]);
    expect(detectSensitive("IBAN ES91 2100 0418 4502 0005 1332").sensitive).toBe(true);
    expect(detectSensitive("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123").reasons).toEqual(["bearer token"]);
  });

  it("leaves ordinary text alone", () => {
    expect(detectSensitive("explícame cómo funciona la contraseña de un hash").sensitive).toBe(false);
    expect(detectSensitive("mi número es 4111 1111 1111 1112").sensitive).toBe(false); // fails Luhn
    expect(detectSensitive("el pedido 20240131123456 salió ayer").sensitive).toBe(false);
  });
});

describe("classifyTask needsTools", () => {
  it("is set for file work and projects, not for plain questions", () => {
    expect(classifyTask("lee el archivo notas.txt").needsTools).toBe(true);
    expect(classifyTask("qué hay en ./src/main.ts").needsTools).toBe(true);
    expect(classifyTask("crea un proyecto de blog").needsTools).toBe(true);
    expect(classifyTask("qué es un monad").needsTools).toBe(false);
  });
});

const cap = (model: string, over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  model, provider: "fake", supportsVision: false, supportsTools: true, supportsStreaming: true,
  contextWindow: 100_000, estimatedInputCost: 0, estimatedOutputCost: 0, expectedLatency: 1, isLocal: false, ...over,
});

function build(models: ModelCapabilities[], toolCalls = true) {
  const events: OrchestratorEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  const provider = new FakeProvider("fake", models, () => "respuesta suficientemente larga y útil");
  Object.assign(provider, { supportsToolCalls: toolCalls });
  const orch = new Orchestrator({
    bus, intents: new IntentRouter({ apps: {} }), router: new AlwaysCheapestRouter(),
    providers: new ProviderRegistry().register(provider), tools: new ToolRegistry(),
    policy: new PolicyEngine(), askPermission: async () => true, traces: new MemoryTraceStore(),
  });
  return { orch, events };
}

describe("orchestrator hard constraints", () => {
  it("sends sensitive input only to a local model", async () => {
    const { orch, events } = build([cap("cloud"), cap("local", { isLocal: true, estimatedInputCost: 5 })]);
    const t = await orch.run("mi clave es hunter2!!, guárdala");
    expect(t.attempts[0]?.model).toBe("local");
    expect(events.some((e) => e.type === "progress" && e.stage.includes("sensibles"))).toBe(true);
  });

  it("refuses to route sensitive input when no local model exists", async () => {
    const { orch, events } = build([cap("cloud")]);
    const t = await orch.run("mi clave es hunter2!!");
    expect(t.finalOutcome).toBe("failure");
    expect(t.attempts).toHaveLength(0);
    expect(events.find((e) => e.type === "task.error")).toMatchObject({ message: expect.stringContaining("not local") });
  });

  it("requires tool support for tasks that act on files, including adapter support", async () => {
    const noTools = build([cap("plain", { supportsTools: false }), cap("tooly")]);
    expect((await noTools.orch.run("lee el archivo notas.txt")).attempts[0]?.model).toBe("tooly");

    const adapterCannot = build([cap("tooly")], false);
    const t = await adapterCannot.orch.run("lee el archivo notas.txt");
    expect(t.finalOutcome).toBe("failure");
    expect(adapterCannot.events.find((e) => e.type === "task.error")).toMatchObject({ message: expect.stringContaining("no tool support") });
  });
});
