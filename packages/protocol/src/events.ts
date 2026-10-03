import { z } from "zod";
import { PermissionLevel, Usage } from "./common";
import { RoutingDecision } from "./models";
import { Verdict } from "./evaluation";

/**
 * OrchestratorEvent is the single stream that drives the UI AND telemetry (ADR-0004).
 * Rule: UI progress is derived only from these events. Nothing renders progress that
 * was not emitted here, so progress can never be faked.
 */
const base = {
  id: z.string(),
  taskId: z.string(),
  seq: z.number().int().nonnegative(),
  /** Unix epoch ms. */
  ts: z.number(),
};

export const OrchestratorEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("task.started"), input: z.string(), modality: z.enum(["text", "voice"]) }),
  z.object({
    ...base,
    type: z.literal("intent.resolved"),
    /** "local" bypasses every LLM. */
    route: z.enum(["local", "llm"]),
    intent: z.string().optional(),
    confidence: z.number().min(0).max(1),
  }),
  z.object({ ...base, type: z.literal("route.decided"), decision: RoutingDecision }),
  z.object({
    ...base,
    type: z.literal("progress"),
    /** What actually happened, e.g. "indexed 214 files". Must describe completed work. */
    stage: z.string(),
    detail: z.string().optional(),
    fraction: z.number().min(0).max(1).optional(),
  }),
  z.object({
    ...base,
    type: z.literal("tool.requested"),
    tool: z.string(),
    risk: PermissionLevel,
    summary: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("permission.required"),
    requestId: z.string(),
    tool: z.string(),
    risk: PermissionLevel,
    reason: z.string(),
  }),
  z.object({ ...base, type: z.literal("permission.resolved"), requestId: z.string(), granted: z.boolean() }),
  z.object({ ...base, type: z.literal("tool.completed"), tool: z.string(), ok: z.boolean(), summary: z.string().optional() }),
  z.object({ ...base, type: z.literal("response.delta"), text: z.string() }),
  z.object({ ...base, type: z.literal("model.completed"), model: z.string(), usage: Usage }),
  z.object({ ...base, type: z.literal("eval.completed"), verdict: Verdict }),
  z.object({
    ...base,
    type: z.literal("escalated"),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("task.finished"),
    outcome: z.enum(["success", "failure", "cancelled"]),
    summary: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("task.error"), message: z.string(), recoverable: z.boolean() }),
]);
export type OrchestratorEvent = z.infer<typeof OrchestratorEvent>;
export type EventType = OrchestratorEvent["type"];
