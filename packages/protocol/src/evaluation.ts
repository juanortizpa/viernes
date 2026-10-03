import { z } from "zod";
import { Usage } from "./common";

export const Outcome = z.enum(["success", "failure", "uncertain"]);
export type Outcome = z.infer<typeof Outcome>;

/** Result of an Evaluator run. Evaluator cost is tracked: it counts toward total cost. */
export const Verdict = z.object({
  evaluator: z.string(), // "tests" | "tool_postcondition" | "llm_judge" | ...
  outcome: Outcome,
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
  usage: Usage.optional(),
});
export type Verdict = z.infer<typeof Verdict>;

/** `uncertain` is never treated as success by the escalation policy. */
export const shouldEscalate = (v: Verdict, minConfidence = 0.7): boolean =>
  v.outcome === "failure" || (v.outcome === "uncertain" && v.confidence < minConfidence);
