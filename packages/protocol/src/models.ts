import { z } from "zod";
import { TaskType } from "./common";

/** Standardized metadata every provider adapter must expose (ADR-0003). */
export const ModelCapabilities = z.object({
  model: z.string(),
  provider: z.string(),
  supportsVision: z.boolean(),
  supportsTools: z.boolean(),
  supportsStreaming: z.boolean(),
  contextWindow: z.number().int().positive(),
  /** USD per 1M tokens. */
  estimatedInputCost: z.number().nonnegative(),
  estimatedOutputCost: z.number().nonnegative(),
  /** Expected time-to-first-token in ms (prior; replaced by measurements over time). */
  expectedLatency: z.number().nonnegative(),
  /** Runs on the user's machine; relevant for data-sensitivity constraints. */
  isLocal: z.boolean().default(false),
  /** Manual strength rank (higher = stronger). Only breaks ties between models of equal price, e.g. an all-free multi-provider setup. */
  tier: z.number().optional(),
  /** Optional cold-start prior of quality per task type, 0..1. Learned data overrides it. */
  qualityPrior: z.record(TaskType, z.number().min(0).max(1)).optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const RouteKind = z.enum(["local_intent", "model"]);

/**
 * The router's output. `propensity` (probability the policy assigned to the chosen
 * action) is mandatory so logged data supports off-policy evaluation (ADR-0006).
 */
export const RoutingDecision = z.object({
  kind: RouteKind,
  /** Absent when kind === "local_intent" (zero LLM tokens). */
  model: z.string().optional(),
  provider: z.string().optional(),
  strategy: z.string(), // e.g. "always_premium" | "rules_v1" | "bandit_v1"
  taskType: TaskType,
  complexity: z.number().min(0).max(1),
  candidates: z
    .array(z.object({ model: z.string(), score: z.number(), reason: z.string().optional() }))
    .default([]),
  propensity: z.number().min(0).max(1),
  /** True when the choice was an exploration step rather than the greedy one. */
  explored: z.boolean().default(false),
  rationale: z.string(),
});
export type RoutingDecision = z.infer<typeof RoutingDecision>;
