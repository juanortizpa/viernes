import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@jarvis/protocol";
import { AlwaysCheapestRouter, AlwaysPremiumRouter, RulesRouter, classifyTask, escalationLadder, estimateCostUsd, filterCandidates } from "../src";

const cap = (model: string, o: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  model, provider: "p", supportsVision: false, supportsTools: true, supportsStreaming: true,
  contextWindow: 100_000, estimatedInputCost: 1, estimatedOutputCost: 1, expectedLatency: 100, isLocal: false, ...o,
});
const cheap = cap("cheap", { estimatedInputCost: 0.15, estimatedOutputCost: 0.6 });
const premium = cap("premium", { estimatedInputCost: 5, estimatedOutputCost: 15, supportsVision: true });
const local = cap("local", { isLocal: true, supportsTools: false, contextWindow: 4_000, estimatedInputCost: 0, estimatedOutputCost: 0 });
const all = [cheap, premium, local];
const req = (o = {}) => ({ input: "x", taskType: "qa_simple" as const, complexity: 0.2, ...o });

describe("filterCandidates", () => {
  it("applies hard constraints and says why", () => {
    const f = filterCandidates(req({ needsTools: true, needsVision: true }), all);
    expect(f.eligible.map((c) => c.model)).toEqual(["premium"]);
    expect(f.rejected).toEqual([
      { model: "cheap", reason: "no vision support" },
      { model: "local", reason: "no tool support" },
    ]);
    expect(filterCandidates(req({ sensitive: true }), all).eligible.map((c) => c.model)).toEqual(["local"]);
    expect(filterCandidates(req({ inputTokens: 10_000 }), all).eligible.map((c) => c.model)).toEqual(["cheap", "premium"]);
  });
});

describe("router strategies", () => {
  it("always_premium / always_cheapest pick the extremes among eligible models", () => {
    expect(new AlwaysPremiumRouter().route(req(), all)).toMatchObject({ model: "premium", strategy: "always_premium", propensity: 1 });
    expect(new AlwaysCheapestRouter().route(req(), all).model).toBe("local");
    expect(new AlwaysCheapestRouter().route(req({ needsTools: true }), all).model).toBe("cheap");
  });

  it("rules sends easy work to the cheap model and hard work to the premium one", () => {
    const r = new RulesRouter();
    expect(r.route(req(), [cheap, premium]).model).toBe("cheap");
    expect(r.route(req({ taskType: "coding", complexity: 0.65 }), [cheap, premium]).model).toBe("premium");
    expect(r.route(req({ taskType: "other", complexity: 0.9 }), [cheap, premium]).model).toBe("premium");
  });

  it("with equal prices, configuration order means weakest -> strongest", () => {
    const [a, b, c] = ["a", "b", "c"].map((m) => cap(m, { estimatedInputCost: 0, estimatedOutputCost: 0 }));
    expect(new AlwaysCheapestRouter().route(req(), [a!, b!, c!]).model).toBe("a");
    expect(new AlwaysPremiumRouter().route(req(), [a!, b!, c!]).model).toBe("c");
    expect(new RulesRouter().route(req({ taskType: "coding", complexity: 0.7 }), [a!, b!, c!]).model).toBe("c");
  });

  it("never picks an ineligible model; records rejections; fails explicitly when none qualify", () => {
    const d = new RulesRouter().route(req({ taskType: "coding", needsVision: false, sensitive: true }), all);
    expect(d.model).toBe("local");
    expect(d.candidates).toContainEqual({ model: "cheap", score: 0, reason: "data is sensitive and the model is not local" });
    expect(() => new AlwaysPremiumRouter().route(req({ needsVision: true, sensitive: true }), all)).toThrow(/no eligible model/);
  });
});

describe("tier", () => {
  it("orders equally priced models from different providers by tier, not by registration order", () => {
    const free = { estimatedInputCost: 0, estimatedOutputCost: 0 };
    const mixed = [cap("strong-a", { ...free, provider: "a", tier: 3 }), cap("weak-b", { ...free, provider: "b", tier: 1 }), cap("mid-a", { ...free, provider: "a", tier: 2 }), cap("untiered", free)];
    expect(escalationLadder(req(), mixed).map((c) => c.model)).toEqual(["untiered", "weak-b", "mid-a", "strong-a"]);
    expect(new AlwaysCheapestRouter().route(req(), mixed).model).toBe("untiered");
    expect(new AlwaysPremiumRouter().route(req(), mixed).model).toBe("strong-a");
    // Price still dominates: a paid model outranks any free tier.
    expect(escalationLadder(req(), [...mixed, cap("paid", { estimatedInputCost: 0.1, estimatedOutputCost: 0.1, tier: 0 })]).at(-1)!.model).toBe("paid");
  });
});

describe("classifyTask", () => {
  it.each([
    ["¿Qué es la fotosíntesis?", "qa_simple"],
    ["explícame cómo funciona TCP", "explanation"],
    ["escribe una función que ordene una lista", "coding"],
    ["tengo un error: Traceback (most recent call last)", "debugging"],
    ["investiga y compara tres bases de datos", "research"],
    ["crea un proyecto de app de notas", "agentic_project"],
    ["cuéntame un chiste", "other"],
  ])("%s -> %s", (text, taskType) => {
    expect(classifyTask(text).taskType).toBe(taskType);
  });

  it("scores harder work as more complex and stays within 0..1", () => {
    expect(classifyTask("¿Qué es un átomo?").complexity).toBeLessThan(classifyTask("depura este crash").complexity);
    expect(classifyTask("crea un proyecto app " + "x".repeat(20_000)).complexity).toBeLessThanOrEqual(1);
  });
});

describe("estimateCostUsd", () => {
  it("prices tokens from the capability sheet", () => {
    expect(estimateCostUsd(premium, { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(6.5);
  });
});
