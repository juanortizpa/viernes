import { z } from "zod";
import { TaskType, Usage } from "./common";
import { RoutingDecision } from "./models";
import { Verdict } from "./evaluation";

/** One model attempt within a task (the first attempt, or an escalation). */
export const Attempt = z.object({
  model: z.string(),
  provider: z.string(),
  decision: RoutingDecision,
  usage: Usage,
  verdict: Verdict.optional(),
});
export type Attempt = z.infer<typeof Attempt>;

/**
 * ExecutionTrace is the research dataset row (ADR-0006): everything needed to
 * replay routing decisions offline and to compute cost/success/escalation metrics.
 */
export const ExecutionTrace = z.object({
  taskId: z.string(),
  startedAt: z.number(),
  taskType: TaskType,
  inputTokensEstimate: z.number().int().nonnegative(),
  usedLocalIntent: z.boolean(),
  /** The instant layer (ADR-0015) answered fully ("reply", no attempts) or acknowledged before a model ran ("ack"). Keep out of model comparisons. */
  instant: z.enum(["reply", "ack"]).optional(),
  attempts: z.array(Attempt),
  escalations: z.number().int().nonnegative(),
  finalOutcome: z.enum(["success", "failure", "cancelled"]),
  userIntervened: z.boolean().default(false),
  /** Includes evaluator calls. */
  totalCostUsd: z.number().nonnegative(),
  totalLatencyMs: z.number().nonnegative(),
  /** Cost of the always-premium baseline on this same task, for savings (defined baseline). */
  baselineCostUsd: z.number().nonnegative().optional(),
});
export type ExecutionTrace = z.infer<typeof ExecutionTrace>;
