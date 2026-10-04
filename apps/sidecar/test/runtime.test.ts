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
