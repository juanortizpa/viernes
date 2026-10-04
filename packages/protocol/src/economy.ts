import { z } from "zod";

/**
 * Aggregate of execution traces for the "AI Economy" panel. Every number is derived from stored traces; costs use the
 * prices the user configured (free models cost 0), and savings are measured against the always-premium baseline of ADR-0006.
 */
export const EconomySummary = z.object({
  tasks: z.number().int().nonnegative(),
  /** How each task was answered. */
  byKind: z.object({
    /** At least one model attempt. */
    model: z.number().int().nonnegative(),
    /** Local intent (tool) with no LLM. */
    local: z.number().int().nonnegative(),
    /** Fixed pleasantry reply (instant layer, R1). */
    instant: z.number().int().nonnegative(),
    /** Served from the verified-answer cache (R2). */
    cache: z.number().int().nonnegative(),
  }),
  successRate: z.number().min(0).max(1),
  /** Model tasks that moved to a stronger model at least once. */
  escalatedTasks: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Always-premium cost, only over tasks where it was computable. */
  baselineCostUsd: z.number().nonnegative(),
  /** baseline - actual over those same tasks. */
  savedUsd: z.number(),
  /** null when there is no priced baseline (e.g. only free models), so no percentage is claimed. */
  savedPct: z.number().nullable(),
  /** Mean latency by kind, ms; null when there are no tasks of that kind. */
  avgLatencyMs: z.object({ model: z.number().nullable(), noLlm: z.number().nullable() }),
  /** Most used models. */
  models: z.array(z.object({ model: z.string(), tasks: z.number().int(), costUsd: z.number() })).max(5),
});
export type EconomySummary = z.infer<typeof EconomySummary>;
