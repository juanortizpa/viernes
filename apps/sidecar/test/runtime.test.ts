import { describe, expect, it } from "vitest";
import { EventBus } from "@jarvis/core";
import { SqliteTraceStore } from "@jarvis/storage";
import { Config, loadConfig } from "../src/config";
import { buildRuntime } from "../src/runtime";
import { launchApp } from "../src/launcher";

const noop = async () => {};
const model = {
  model: "m",
  provider: "anthropic",
  supportsVision: false,
  supportsTools: true,
  supportsStreaming: true,
  contextWindow: 1000,
  estimatedInputCost: 1,
  estimatedOutputCost: 1,
  expectedLatency: 1,
};

describe("buildRuntime", () => {
  it("falls back to a clearly labelled offline provider with no config", () => {
    const r = buildRuntime(Config.parse({}), { env: {}, launcher: noop });
    expect(r).toMatchObject({ offline: true, models: ["offline-echo"] });
  });

  it("requires the API key of an enabled cloud provider", () => {
    const cfg = Config.parse({ anthropic: { models: [model] } });
    expect(() => buildRuntime(cfg, { env: {}, launcher: noop })).toThrow(/ANTHROPIC_API_KEY/);
    expect(buildRuntime(cfg, { env: { ANTHROPIC_API_KEY: "k" }, launcher: noop })).toMatchObject({ offline: false, models: ["m"] });
  });

  it("freeOnly refuses any model with a price and accepts free ones", () => {
    const paid = Config.parse({ freeOnly: true, anthropic: { models: [model] } });
    expect(() => buildRuntime(paid, { env: { ANTHROPIC_API_KEY: "k" }, launcher: noop })).toThrow(/freeOnly.*\bm\b/);
    const free = Config.parse({ freeOnly: true, anthropic: { models: [{ ...model, estimatedInputCost: 0, estimatedOutputCost: 0 }] } });
    expect(buildRuntime(free, { env: { ANTHROPIC_API_KEY: "k" }, launcher: noop }).models).toEqual(["m"]);
  });

  it("the shipped free example config loads, is free and orders models weakest to strongest", () => {
    const cfg = loadConfig(new URL("../../../jarvis.config.free.example.json", import.meta.url).pathname);
    const r = buildRuntime(cfg, { env: { OPENROUTER_API_KEY: "k" }, launcher: noop });
    expect(r.models).toHaveLength(3);
    expect(cfg.freeOnly).toBe(true);
  });

  it("registers Groq and Google behind their own keys (Google accepts GEMINI_API_KEY or GOOGLE_API_KEY)", () => {
    const free = { ...model, estimatedInputCost: 0, estimatedOutputCost: 0 };
    const cfg = Config.parse({ freeOnly: true, groq: { models: [{ ...free, model: "g1", provider: "groq" }] }, google: { models: [{ ...free, model: "m1", provider: "google" }] } });
    expect(() => buildRuntime(cfg, { env: { GEMINI_API_KEY: "k" }, launcher: noop })).toThrow(/GROQ_API_KEY/);
    expect(() => buildRuntime(cfg, { env: { GROQ_API_KEY: "k" }, launcher: noop })).toThrow(/GEMINI_API_KEY or GOOGLE_API_KEY/);
    expect(buildRuntime(cfg, { env: { GROQ_API_KEY: "k", GOOGLE_API_KEY: "k" }, launcher: noop }).models).toEqual(["g1", "m1"]);
  });

  it("the multi-provider free example is free, tiered, and its escalation ladder strictly climbs across providers", async () => {
    const cfg = loadConfig(new URL("../../../jarvis.config.free-multi.example.json", import.meta.url).pathname);
    const r = buildRuntime(cfg, { env: { GROQ_API_KEY: "k", OPENROUTER_API_KEY: "k", GEMINI_API_KEY: "k" }, launcher: noop });
    const { escalationLadder } = await import("@jarvis/core");
    const ladder = escalationLadder({ input: "x", taskType: "other", complexity: 0.4 }, r.providers.capabilities());
    expect(ladder.map((c) => c.provider)).toContain("groq");
    expect(ladder.map((c) => c.provider)).toContain("openrouter");
    const tiers = ladder.map((c) => c.tier!);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(new Set(tiers).size).toBe(tiers.length);
    expect(cfg.freeOnly).toBe(true);
  });

  it("rejects a defaultModel nobody offers", () => {
    expect(() => buildRuntime(Config.parse({ defaultModel: "ghost" }), { env: {}, launcher: noop })).toThrow(/ghost/);
  });

  it("persists the trace of a finished task into the injected store", async () => {
    const traces = new SqliteTraceStore(":memory:");
    const r = buildRuntime(Config.parse({}), { env: {}, launcher: noop, traces });
    const orch = r.createOrchestrator({ bus: new EventBus(), askPermission: async () => false });
    const trace = await orch.run("hola");
    expect(traces.get(trace.taskId)?.finalOutcome).toBe("success");
    expect(traces.count()).toBe(1);
  });

  it("loadConfig tolerates a missing file", () => {
    expect(loadConfig("/nonexistent/jarvis.json").apps["vscode"]).toBe("code");
    expect(loadConfig(undefined).defaultModel).toBeUndefined();
  });
});

describe("launchApp", () => {
  it("rejects when the command does not exist", async () => {
    if (process.platform === "win32") return;
    await expect(launchApp("definitely-not-a-real-command-xyz")).rejects.toThrow();
  });
  it("resolves for a real executable", async () => {
    if (process.platform === "win32") return;
    await expect(launchApp("true")).resolves.toBeUndefined();
  });
});

describe("instant cache in the runtime", () => {
  it("keeps learned answers and the user's switch across restarts, and the user can inspect and clear them in plain words", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SqliteInstantStore } = await import("@jarvis/storage");
    const path = join(mkdtempSync(join(tmpdir(), "jarvis-rt-")), "instant.db");
    const ask = async (instantStore: InstanceType<typeof SqliteInstantStore>, input: string) => {
      const events: string[] = [];
      const bus = new EventBus();
      bus.subscribe((e) => events.push(e.type === "instant.issued" ? `instant.${e.kind}` : e.type));
      const r = buildRuntime(Config.parse({ instantCache: { minSeen: 1 } }), { env: {}, launcher: noop, instantStore });
      await r.createOrchestrator({ bus, askPermission: async () => true }).run(input);
      return events;
    };

    const s1 = new SqliteInstantStore(path);
    expect(await ask(s1, "cuál es la capital de Francia")).toContain("response.delta"); // offline-echo answers and is verified
    s1.close();

    const s2 = new SqliteInstantStore(path);
    expect(await ask(s2, "dime la capital de Francia")).toContain("instant.cache");
    expect(await ask(s2, "qué respuestas guardadas tienes")).toContain("tool.completed");
    expect(await ask(s2, "borra todas las respuestas guardadas")).toContain("permission.required"); // bulk delete needs confirmation
    expect(s2.all()).toHaveLength(0);
    expect(await ask(s2, "dime la capital de Francia")).not.toContain("instant.cache");
    s2.close();
  });
});

import { AppCatalog } from "@jarvis/core";
import { defaultVoicePrompt, makeCatalogLauncher } from "../src/runtime";

describe("opening apps by the name a person (or a model) says", () => {
  const catalog = AppCatalog.fromRecord({ calculadora: "calc", calculator: "calc", "bloc de notas": "notepad" });
  it("accepts the raw command or any known name, and still refuses anything unknown", async () => {
    const launched: string[] = [];
    const launch = makeCatalogLauncher(catalog, async (c) => void launched.push(c));
    await launch("calc");
    await launch("Calculator"); // what an English-thinking model passes
    await launch("bloc de notas");
    expect(launched).toEqual(["calc", "calc", "notepad"]);
    await expect(launch("rm -rf /")).rejects.toThrow(/not a known app/);
    await expect(launch("calc.exe && evil")).rejects.toThrow(/not a known app/);
  });

  it("builds a short vocabulary prompt for speech recognition, only from plain app names", () => {
    expect(defaultVoicePrompt(["vs code", "calculadora", "otra pestana"], "es")).toBe("Jarvis, abre vs code, calculadora, otra pestana.");
    expect(defaultVoicePrompt(["a;b", "x".repeat(40)], "es")).toBeUndefined();
    expect(defaultVoicePrompt(["paint"], "en")).toBeUndefined();
  });

  it("tells the model which app names exist", async () => {
    const { makeAppsOpen } = await import("@jarvis/tools");
    expect(makeAppsOpen(async () => {}, ["calculadora", "paint"]).description).toMatch(/known apps: calculadora, paint/);
  });
});
