import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelCapabilities, OrchestratorEvent } from "@jarvis/protocol";
import { MemoryAuditLog, PolicyEngine } from "@jarvis/policy";
import { FakeProvider, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry, filesWrite, makeAppsOpen, timeNow } from "@jarvis/tools";
import { EventBus, IntentRouter, MemoryTraceStore, Orchestrator, StaticRouter, TaskMachine } from "../src";

const notePath = join(mkdtempSync(join(tmpdir(), "jarvis-orch-")), "note.txt");

const model: ModelCapabilities = {
  model: "cheap",
  provider: "fake",
  supportsVision: false,
  supportsTools: true,
  supportsStreaming: true,
  contextWindow: 10_000,
  estimatedInputCost: 1_000_000,
  estimatedOutputCost: 1_000_000,
  expectedLatency: 100,
  isLocal: false,
};

type Deps = ConstructorParameters<typeof Orchestrator>[0];

function setup(grant = true, overrides: Partial<Deps> = {}) {
  const bus = new EventBus();
  const events: OrchestratorEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const opened: string[] = [];
  const audit = new MemoryAuditLog();
  const traces = new MemoryTraceStore();
  const asked: string[] = [];
  const orch = new Orchestrator({
    bus,
    intents: new IntentRouter({
      apps: { "vs code": "code", vscode: "code" },
      rules: [
        (t) =>
          t === "guarda nota"
            ? { route: "local", intent: "files.write", tool: "files.write", args: { path: notePath, content: "nota" }, confidence: 1 }
            : undefined,
      ],
    }),
    router: new StaticRouter("cheap"),
    providers: new ProviderRegistry().register(new FakeProvider("fake", [model], () => "hola mundo")),
    tools: new ToolRegistry().register(timeNow).register(makeAppsOpen(async (a) => void opened.push(a))).register(filesWrite),
    policy: new PolicyEngine({}, audit),
    askPermission: async (r) => {
      asked.push(r.tool);
      return grant;
    },
    traces,
    ...overrides,
  });
  return { orch, events, opened, audit, traces, asked };
}

const types = (events: OrchestratorEvent[]) => events.map((e) => e.type);

describe("Orchestrator — local intent (no LLM)", () => {
  it("opens a known app with zero model usage", async () => {
    const { orch, events, opened, traces } = setup();
    const trace = await orch.run("abre VS Code");
    expect(opened).toEqual(["code"]);
    expect(types(events)).toEqual(["task.started", "intent.resolved", "tool.requested", "tool.completed", "task.finished"]);
    expect(trace).toMatchObject({ usedLocalIntent: true, taskType: "local_action", attempts: [], totalCostUsd: 0, finalOutcome: "success" });
    expect(traces.traces).toHaveLength(1);
  });

  it("assigns increasing seq per task", async () => {
    const { orch, events } = setup();
    await orch.run("qué hora es?");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it("unknown app falls through to the model instead of guessing", async () => {
    const { orch, events } = setup();
    await orch.run("abre un debate sobre IA");
    expect(types(events)).toContain("route.decided");
  });
});

describe("Orchestrator — model path", () => {
  it("routes, streams, records usage and cost", async () => {
    const { orch, events } = setup();
    const trace = await orch.run("hola");
    expect(types(events)).toEqual([
      "task.started",
      "intent.resolved",
      "route.decided",
      "response.delta",
      "response.delta",
      "model.completed",
      "task.finished",
    ]);
    expect(trace.attempts).toHaveLength(1);
    expect(trace.attempts[0]?.decision.propensity).toBe(1);
    expect(trace.totalCostUsd).toBeGreaterThan(0);
    expect(trace.finalOutcome).toBe("success");
  });

  it("emits task.error then task.finished(failure) when the provider fails", async () => {
    const { orch, events } = setup(true, {
      providers: new ProviderRegistry().register(
        new FakeProvider("fake", [model], () => {
          throw new Error("provider down");
        }),
      ),
    });
    const trace = await orch.run("hola");
    expect(types(events).slice(-2)).toEqual(["task.error", "task.finished"]);
    expect(trace.finalOutcome).toBe("failure");
  });
});

describe("Orchestrator — policy and permissions", () => {
  it("asks permission for a sensitive tool, runs it when granted, verifies and audits", async () => {
    rmSync(notePath, { force: true });
    const { orch, events, audit, asked, traces } = setup(true);
    const trace = await orch.run("guarda nota");
    expect(asked).toEqual(["files.write"]);
    expect(types(events)).toEqual([
      "task.started",
      "intent.resolved",
      "tool.requested",
      "permission.required",
      "permission.resolved",
      "tool.completed",
      "eval.completed",
      "task.finished",
    ]);
    expect(existsSync(notePath)).toBe(true);
    expect(trace).toMatchObject({ userIntervened: true, finalOutcome: "success" });
    expect(audit.entries.map((e) => e.granted)).toEqual([undefined, true]);
    expect(traces.traces).toHaveLength(1);
  });

  it("does not run the tool when the user denies", async () => {
    rmSync(notePath, { force: true });
    const { orch, events } = setup(false);
    const trace = await orch.run("guarda nota");
    expect(types(events)).not.toContain("tool.completed");
    expect(events.find((e) => e.type === "permission.resolved")).toMatchObject({ granted: false });
    expect(existsSync(notePath)).toBe(false);
    expect(trace.finalOutcome).toBe("failure");
  });

  it("denied-by-config tool never asks and never runs", async () => {
    const { orch, events, asked } = setup(true, { policy: new PolicyEngine({ denyTools: new Set(["files.write"]) }) });
    const trace = await orch.run("guarda nota");
    expect(asked).toEqual([]);
    expect(types(events)).not.toContain("permission.required");
    expect(trace.finalOutcome).toBe("failure");
  });
});

describe("Orchestrator — cancellation", () => {
  it("reports cancelled when aborted while waiting for permission", async () => {
    const ac = new AbortController();
    const { orch } = setup(true, {
      askPermission: async () => {
        ac.abort();
        return false;
      },
    });
    const trace = await orch.run("guarda nota", { signal: ac.signal });
    expect(trace.finalOutcome).toBe("cancelled");
  });
});

describe("TaskMachine", () => {
  it("rejects invalid transitions", () => {
    const m = new TaskMachine();
    m.to("routing");
    m.to("running");
    m.to("finished");
    expect(() => m.to("running")).toThrow();
  });
});
