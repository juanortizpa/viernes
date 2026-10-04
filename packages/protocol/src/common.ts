import { z } from "zod";

/** Permission levels, ordered by severity (see ADR-0005). */
export const PermissionLevel = z.enum(["read", "reversible", "sensitive", "critical"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

const ORDER: Record<PermissionLevel, number> = { read: 0, reversible: 1, sensitive: 2, critical: 3 };
export const compareRisk = (a: PermissionLevel, b: PermissionLevel): number => ORDER[a] - ORDER[b];

/** Where a piece of content came from. Drives taint tracking in the policy engine. */
export const Provenance = z.enum(["user", "system", "memory", "tool_trusted", "untrusted_external"]);
export type Provenance = z.infer<typeof Provenance>;

export const TaskType = z.enum([
  "local_action", // deterministic intent, no LLM
  "qa_simple",
  "explanation",
  "coding",
  "debugging",
  "research",
  "agentic_project", // multi-step, tools + code changes
  "other",
]);
export type TaskType = z.infer<typeof TaskType>;

/** Token usage and cost for one model call. Costs are USD estimates. */
export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  timeToFirstTokenMs: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;
