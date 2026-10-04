import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelCapabilities, OrchestratorEvent } from "@jarvis/protocol";
import { PolicyEngine } from "@jarvis/policy";
import { FakeProvider, ProviderRegistry, type FakeReply } from "@jarvis/providers";
import { ToolRegistry, filesWrite, makeAppsOpen, timeNow } from "@jarvis/tools";
import {
  AlwaysCheapestRouter, CodeTestsEvaluator, EventBus, IntentRouter, MemoryTraceStore, Orchestrator,
  ResponseHeuristicEvaluator, runEvaluators, type Evaluator,
} from "../src";

const cap = (model: string, cost = 0): ModelCapabilities => ({
  model, provider: "fake", supportsVision: false, supportsTools: true, supportsStreaming: true,
  contextWindow: 100_000, estimatedInputCost: cost, estimatedOutputCost: cost, expectedLatency: 1, isLocal: false,
});

function setup(replies: Record<string, FakeReply | (() => FakeReply)>, opts: { evaluators?: Evaluator[]; max?: number; models?: ModelCapabilities[]; launched?: string[] } = {}) {
  const events: OrchestratorEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  const calls: string[] = [];
  const models = opts.models ?? [cap("small"), cap("medium"), cap("large")];
  const orch = new Orchestrator({
    bus,
    intents: new IntentRouter({ apps: {} }),
    router: new AlwaysCheapestRouter(),
    providers: new ProviderRegistry().register(
      new FakeProvider("fake", models, (req) => {
        calls.push(req.model);
        const r = replies[req.model] ?? "respuesta suficientemente larga y útil para el usuario";
        return typeof r === "function" ? r() : r;
      }),
    ),
    tools: new ToolRegistry().register(timeNow).register(filesWrite).register(makeAppsOpen(async (a) => void opts.launched?.push(a))),
    policy: new PolicyEngine(),
    askPermission: async () => true,
    traces: new MemoryTraceStore(),
    evaluators: opts.evaluators ?? [new ResponseHeuristicEvaluator()],
    maxEscalations: opts.max ?? 2,
  });
  return { orch, events, calls, bus };
}

describe("evaluators", () => {
  const h = new ResponseHeuristicEvaluator();
  const ev = (taskType: Parameters<Evaluator["evaluate"]>[0]["taskType"], response: string) => h.evaluate({ input: "x", taskType, response });

  it("flags broken responses and passes ordinary ones with modest confidence", () => {
    expect(ev("qa_simple", "   ")).toMatchObject({ outcome: "failure", confidence: 1 });
    expect(ev("qa_simple", "igual\n".repeat(7))).toMatchObject({ outcome: "failure", evidence: "degenerate repetition" });
    expect(ev("qa_simple", "Lo siento, pero no puedo ayudar con eso.")).toMatchObject({ outcome: "uncertain" });
    expect(ev("coding", "ok")).toMatchObject({ outcome: "uncertain" });
    expect(ev("coding", "Se hace con una lista y un bucle, sin más detalle que ese párrafo.")).toMatchObject({ outcome: "uncertain" });
    expect(ev("coding", "Aquí está la solución:\n```py\nprint(sum(range(10)))\n```")).toMatchObject({ outcome: "success", confidence: 0.6 });
  });

  it("code tests evaluator runs the first code block and skips non-coding tasks", async () => {
    const seen: string[] = [];
    const t = new CodeTestsEvaluator(async (code) => (seen.push(code), { passed: code.includes("ok"), output: "1 passed" }));
    expect(await t.evaluate({ input: "x", taskType: "qa_simple", response: "```js\nok\n```" })).toBeUndefined();
    expect(await t.evaluate({ input: "x", taskType: "coding", response: "```js\nok()\n```" })).toMatchObject({ outcome: "success", confidence: 1 });
    expect(await t.evaluate({ input: "x", taskType: "coding", response: "```js\nbad()\n```" })).toMatchObject({ outcome: "failure" });
    expect(await t.evaluate({ input: "x", taskType: "coding", response: "sin código" })).toMatchObject({ outcome: "uncertain" });
    expect(seen).toEqual(["ok()\n", "bad()\n"]);
    const boom = new CodeTestsEvaluator(async () => Promise.reject(new Error("sandbox down")));
    expect(await boom.evaluate({ input: "x", taskType: "coding", response: "```js\nx\n```" })).toMatchObject({ outcome: "uncertain" });
  });

  it("combines verdicts: worst outcome wins, minimum confidence, evaluator costs add up", async () => {
    const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, estimatedCostUsd: 0.5, latencyMs: 1 };
    const a: Evaluator = { name: "a", evaluate: () => ({ evaluator: "a", outcome: "success", confidence: 0.9, evidence: "a", usage }) };
    const b: Evaluator = { name: "b", evaluate: () => ({ evaluator: "b", outcome: "uncertain", confidence: 0.4, evidence: "b", usage }) };
    const skip: Evaluator = { name: "s", evaluate: () => undefined };
    expect(await runEvaluators([a, skip, b], { input: "", taskType: "other", response: "" })).toMatchObject({
      evaluator: "a+b", outcome: "uncertain", confidence: 0.4, evidence: "b", usage: { estimatedCostUsd: 1 },
    });
    expect(await runEvaluators([skip], { input: "", taskType: "other", response: "" })).toBeUndefined();
  });
});

describe("cascade", () => {
  it("keeps a good first answer: one attempt, no escalation", async () => {
    const { orch, calls, events } = setup({});
    const t = await orch.run("cuéntame algo");
    expect(calls).toEqual(["small"]);
    expect(t).toMatchObject({ escalations: 0, finalOutcome: "success" });
    expect(events.some((e) => e.type === "escalated")).toBe(false);
    expect(t.attempts[0]?.verdict?.outcome).toBe("success");
  });

  it("escalates up the cost ladder until an attempt passes, recording each attempt", async () => {
    const { orch, calls, events } = setup({ small: "", medium: "Lo siento, pero no puedo ayudar con eso." });
    const t = await orch.run("cuéntame algo");
    expect(calls).toEqual(["small", "medium", "large"]);
    expect(t.escalations).toBe(2);
    expect(t.attempts.map((a) => [a.model, a.verdict?.outcome, a.decision.strategy])).toEqual([
      ["small", "failure", "always_cheapest"],
      ["medium", "uncertain", "cascade_v1"],
      ["large", "success", "cascade_v1"],
    ]);
    expect(events.filter((e) => e.type === "escalated").map((e) => e.type === "escalated" && [e.from, e.to])).toEqual([["small", "medium"], ["medium", "large"]]);
    expect(t.finalOutcome).toBe("success");
  });

  it("stops at maxEscalations; an uncertain answer is still delivered, a failure is not", async () => {
    const refuse = "Lo siento, pero no puedo ayudar con eso.";
    const a = setup({ small: refuse, medium: refuse, large: refuse }, { max: 1 });
    expect(await a.orch.run("hola")).toMatchObject({ escalations: 1, finalOutcome: "success" });
    expect(a.calls).toEqual(["small", "medium"]);

    const b = setup({ small: "", medium: "", large: "" }, { max: 1 });
    expect(await b.orch.run("hola")).toMatchObject({ escalations: 1, finalOutcome: "failure" });
  });

  it("never escalates without evaluators or with maxEscalations 0", async () => {
    const a = setup({ small: "" }, { evaluators: [] });
    expect(await a.orch.run("hola")).toMatchObject({ escalations: 0, finalOutcome: "success" });
    const b = setup({ small: "" }, { max: 0 });
    expect(await b.orch.run("hola")).toMatchObject({ escalations: 0, finalOutcome: "failure" });
    expect(b.calls).toEqual(["small"]);
  });

  it("does not escalate after a tool that cannot be undone (it would repeat the side effect)", async () => {
    const launched: string[] = [];
    let step = 0;
    const { orch, calls } = setup(
      { small: () => (step++ === 0 ? { toolCalls: [{ id: "1", name: "apps.open", args: { app: "notepad" } }] } : "") },
      { launched },
    );
    const t = await orch.run("hola");
    expect(launched).toEqual(["notepad"]);
    expect(calls).toEqual(["small", "small"]); // tool step, then the empty final answer; no jump to "medium"
    expect(t).toMatchObject({ escalations: 0, finalOutcome: "failure" });
  });

  describe("checkpoints", () => {
    const writeThenEmpty = (path: string, content: string) => {
      let step = 0;
      return () => (step++ === 0 ? { toolCalls: [{ id: "1", name: "files.write", args: { path, content } }] } : "");
    };

    it("rolls back a file write and escalates when the attempt then fails", async () => {
      const path = join(mkdtempSync(join(tmpdir(), "jarvis-cp-")), "x.txt");
      writeFileSync(path, "original");
      const { orch, calls, events } = setup({ small: writeThenEmpty(path, "bad draft") });
      const t = await orch.run("hola");
      expect(calls).toEqual(["small", "small", "medium"]);
      expect(readFileSync(path, "utf8")).toBe("original");
      expect(events.find((e) => e.type === "checkpoint.restored")).toMatchObject({ tool: "files.write", ok: true });
      expect(t).toMatchObject({ escalations: 1, finalOutcome: "success" });
    });

    it("removes a file the failed attempt created", async () => {
      const path = join(mkdtempSync(join(tmpdir(), "jarvis-cp-")), "new.txt");
      const { orch } = setup({ small: writeThenEmpty(path, "x") });
      await orch.run("hola");
      expect(existsSync(path)).toBe(false);
    });

    it("does not escalate when the file changed after the write (restoring would clobber someone else's edit)", async () => {
      const path = join(mkdtempSync(join(tmpdir(), "jarvis-cp-")), "x.txt");
      let step = 0;
      const { orch, calls, events, bus } = setup({
        small: () => {
          if (step++ > 0) return "";
          return { toolCalls: [{ id: "1", name: "files.write", args: { path, content: "mine" } }] };
        },
      });
      // The user edits the file between the write and the rollback (the empty answer triggers the rollback).
      const offEdit = bus.subscribe((e) => e.type === "tool.completed" && writeFileSync(path, "user edit"));
      const t = await orch.run("hola");
      offEdit();
      expect(readFileSync(path, "utf8")).toBe("user edit");
      expect(calls).toEqual(["small", "small"]);
      expect(events.find((e) => e.type === "checkpoint.restored")).toMatchObject({ ok: false });
      expect(t).toMatchObject({ escalations: 0, finalOutcome: "failure" });
    });
  });

  it("escalates on a provider error (e.g. free-tier rate limit) instead of failing the task", async () => {
    let n = 0;
    const { orch, calls } = setup({ small: () => { n++; throw new Error("429 rate limited"); } });
    const t = await orch.run("hola");
    expect(n).toBe(1);
    expect(calls).toEqual(["small", "medium"]);
    expect(t.finalOutcome).toBe("success");
    expect(t.attempts[0]?.verdict?.evidence).toContain("provider error: 429 rate limited");
  });

  it("escalates on a provider error even when every evaluator abstains or ignores failures", async () => {
    const abstain: Evaluator = { name: "abstain", evaluate: () => undefined };
    const optimistic: Evaluator = { name: "optimistic", evaluate: () => ({ evaluator: "optimistic", outcome: "success", confidence: 1, evidence: "fine" }) };
    for (const evaluators of [[abstain], [optimistic]]) {
      const { orch, calls } = setup({ small: () => { throw new Error("429"); } }, { evaluators });
      const t = await orch.run("hola");
      expect(calls).toEqual(["small", "medium"]);
      expect(t.finalOutcome).toBe("success");
    }
  });

  it("rethrows the provider error when no model is left to escalate to", async () => {
    const { orch, events } = setup({ small: () => { throw new Error("boom"); } }, { models: [cap("small")] });
    const t = await orch.run("hola");
    expect(t.finalOutcome).toBe("failure");
    expect(events.find((e) => e.type === "task.error")).toMatchObject({ message: "boom" });
  });

  it("counts evaluator cost in the trace total", async () => {
    const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, estimatedCostUsd: 0.25, latencyMs: 1 };
    const judge: Evaluator = { name: "judge", evaluate: () => ({ evaluator: "judge", outcome: "success", confidence: 0.9, evidence: "ok", usage }) };
    const { orch } = setup({}, { evaluators: [judge] });
    expect((await orch.run("hola")).totalCostUsd).toBeCloseTo(0.25);
  });
});
