import { z } from "zod";
import { TaskType } from "@jarvis/protocol";

/** Ground truth for one task. Every kind is deterministic: the experiment never depends on an LLM judge. */
export const Check = z.discriminatedUnion("kind", [
  /** The final line (or the whole answer) equals `answer` after normalisation. */
  z.object({ kind: z.literal("exact"), answer: z.string() }),
  /** Every value appears in the answer (normalised). */
  z.object({ kind: z.literal("contains_all"), values: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("regex"), pattern: z.string(), flags: z.string().optional() }),
  /** The last number in the answer. */
  z.object({ kind: z.literal("number"), value: z.number(), tolerance: z.number().nonnegative().default(0) }),
  /** The first JS code block is run, then `tests` (which may call `assert`) in a permission-restricted Node process. */
  z.object({ kind: z.literal("code_tests"), tests: z.string() }),
]);
export type Check = z.infer<typeof Check>;

export const EvalTask = z.object({
  id: z.string(),
  suite: z.string(),
  lang: z.enum(["es", "en"]),
  /** Human label, for analysis only. Routers never see it; they classify the prompt themselves. */
  type: TaskType,
  prompt: z.string(),
  check: Check,
  /** A response that must pass `check`. Validates the ground truth itself (see tests). */
  reference: z.string(),
});
export type EvalTask = z.infer<typeof EvalTask>;

export interface Grade {
  pass: boolean;
  detail: string;
}

/** One model on one task, once. The unit of the counterfactual table. */
export interface Cell {
  taskId: string;
  model: string;
  response: string;
  pass: boolean;
  detail: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Set when the call itself failed (rate limit, 5xx). Such cells carry no evidence about the model and are retried. */
  error?: string;
  ts: number;
}

/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
}
export type PriceBook = Record<string, Price>;
