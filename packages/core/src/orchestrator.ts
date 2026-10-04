import { randomUUID } from "node:crypto";
import type { Attempt, ExecutionTrace, RoutingDecision, Usage } from "@jarvis/protocol";
import { TaintTracker, type PolicyEngine } from "@jarvis/policy";
import type { ProviderRegistry } from "@jarvis/providers";
import type { ToolRegistry } from "@jarvis/tools";
import { EventBus, TaskEmitter } from "./bus";
import type { IntentRouter } from "./intent";
import type { ModelRouter } from "./model-router";
import { TaskMachine } from "./task-state";
import type { TraceStore } from "./trace-store";

export interface PermissionRequest {
  requestId: string;
  taskId: string;
  tool: string;
  risk: "read" | "reversible" | "sensitive" | "critical";
  reason: string;
}
/** The shell (UI) answers; headless runs can deny by default. */
export type PermissionResolver = (req: PermissionRequest) => Promise<boolean>;

export interface OrchestratorDeps {
  bus: EventBus;
  intents: IntentRouter;
  router: ModelRouter;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  policy: PolicyEngine;
  askPermission: PermissionResolver;
  traces: TraceStore;
  now?: () => number;
  newId?: () => string;
}

export interface RunOptions {
  modality?: "text" | "voice";
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = "You are JARVIS, a concise personal assistant. Answer in the user's language.";

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async run(input: string, opts: RunOptions = {}): Promise<ExecutionTrace> {
    const now = this.deps.now ?? Date.now;
    const newId = this.deps.newId ?? randomUUID;
    const taskId = newId();
    const out = new TaskEmitter(taskId, this.deps.bus, now, newId);
    const machine = new TaskMachine();
    const startedAt = now();

    const trace: ExecutionTrace = {
      taskId,
      startedAt,
      taskType: "other",
      inputTokensEstimate: Math.ceil(input.length / 4),
      usedLocalIntent: false,
      attempts: [],
      escalations: 0,
      finalOutcome: "failure",
      userIntervened: false,
      totalCostUsd: 0,
      totalLatencyMs: 0,
    };

    out.emit({ type: "task.started", input, modality: opts.modality ?? "text" });
    let summary: string | undefined;
    try {
      machine.to("routing");
      const intent = this.deps.intents.resolve(input);
      out.emit({
        type: "intent.resolved",
        route: intent.route,
        intent: intent.route === "local" ? intent.intent : undefined,
        confidence: intent.confidence,
      });

      const result =
        intent.route === "local"
          ? await this.runLocal(taskId, intent.tool, intent.args, out, machine, trace)
          : await this.runModel(input, out, machine, trace, opts.signal);
      trace.finalOutcome = result.outcome;
      summary = result.summary;
    } catch (e) {
      const cancelled = opts.signal?.aborted === true;
      if (!cancelled) out.emit({ type: "task.error", message: e instanceof Error ? e.message : String(e), recoverable: false });
      trace.finalOutcome = cancelled ? "cancelled" : "failure";
    } finally {
      trace.totalLatencyMs = now() - startedAt;
      machine.to("finished");
      out.emit({ type: "task.finished", outcome: trace.finalOutcome, summary });
      await this.deps.traces.save(trace);
    }
    return trace;
  }

  private async runLocal(
    taskId: string,
    toolName: string,
    rawArgs: Record<string, unknown>,
    out: TaskEmitter,
    machine: TaskMachine,
    trace: ExecutionTrace,
  ): Promise<{ outcome: "success" | "failure"; summary?: string }> {
    trace.usedLocalIntent = true;
    trace.taskType = "local_action";

    const tool = this.deps.tools.get(toolName);
    if (!tool) return { outcome: "failure", summary: `unknown tool ${toolName}` };
    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) return { outcome: "failure", summary: `invalid arguments for ${toolName}` };

    out.emit({ type: "tool.requested", tool: tool.name, risk: tool.risk, summary: `${tool.name} ${JSON.stringify(parsed.data)}` });

    const taint = new TaintTracker();
    const policyReq = { taskId, tool: tool.name, risk: tool.risk, tainted: taint.isTainted };
    const decision = this.deps.policy.decide(policyReq);
    if (decision.action === "deny") return { outcome: "failure", summary: decision.reason };
    if (decision.action === "confirm") {
      machine.to("awaiting_permission");
      const requestId = randomUUID();
      out.emit({ type: "permission.required", requestId, tool: tool.name, risk: tool.risk, reason: decision.reason });
      const granted = await this.deps.askPermission({ requestId, taskId, tool: tool.name, risk: tool.risk, reason: decision.reason });
      trace.userIntervened = true;
      this.deps.policy.recordGrant(policyReq, granted);
      out.emit({ type: "permission.resolved", requestId, granted });
      if (!granted) return { outcome: "failure", summary: "permission denied by user" };
    }

    machine.to("running");
    const result = await tool.run(parsed.data, { taskId });
    taint.observe(result.provenance);
    out.emit({ type: "tool.completed", tool: tool.name, ok: result.ok, summary: result.summary });

    if (result.ok && tool.verify) {
      const ok = await tool.verify(parsed.data, result, { taskId });
      out.emit({
        type: "eval.completed",
        verdict: {
          evaluator: "tool_postcondition",
          outcome: ok ? "success" : "failure",
          confidence: 1,
          evidence: ok ? "postcondition holds" : "postcondition failed",
        },
      });
      if (!ok) return { outcome: "failure", summary: "postcondition failed" };
    }
    return { outcome: result.ok ? "success" : "failure", summary: result.summary };
  }

  private async runModel(
    input: string,
    out: TaskEmitter,
    machine: TaskMachine,
    trace: ExecutionTrace,
    signal?: AbortSignal,
  ): Promise<{ outcome: "success" | "failure"; summary?: string }> {
    const decision: RoutingDecision = this.deps.router.route(
      { input, taskType: "other", complexity: 0.5 },
      this.deps.providers.capabilities(),
    );
    out.emit({ type: "route.decided", decision });
    const provider = decision.provider ? this.deps.providers.get(decision.provider) : undefined;
    if (!decision.model || !provider) throw new Error("router selected an unavailable provider");

    machine.to("running");
    let usage: Usage | undefined;
    for await (const chunk of provider.generate({
      model: decision.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: input }],
      signal,
    })) {
      if (chunk.type === "delta") out.emit({ type: "response.delta", text: chunk.text });
      else usage = chunk.usage;
    }
    if (!usage) throw new Error("provider ended without usage");

    out.emit({ type: "model.completed", model: decision.model, usage });
    const attempt: Attempt = { model: decision.model, provider: decision.provider!, decision, usage };
    trace.attempts.push(attempt);
    trace.totalCostUsd += usage.estimatedCostUsd;
    return { outcome: "success" };
  }
}
