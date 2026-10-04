import type { Outcome, TaskType, Usage, Verdict } from "@jarvis/protocol";

export interface EvalInput {
  input: string;
  taskType: TaskType;
  /** Final text the model produced in this attempt. */
  response: string;
  /** Set when the attempt itself broke (e.g. tool step limit); evaluators treat it as a failure. */
  failure?: string;
}

/**
 * Judges one attempt. Returns undefined when it does not apply (e.g. no test runner for this task).
 * Evaluator cost is tracked via `verdict.usage` and counts toward the task total (Phase 2).
 */
export interface Evaluator {
  readonly name: string;
  evaluate(input: EvalInput): Verdict | undefined | Promise<Verdict | undefined>;
}

/** The deterministic check a tool declares after it runs (`Tool.verify`). */
export const toolPostconditionVerdict = (ok: boolean): Verdict => ({
  evaluator: "tool_postcondition",
  outcome: ok ? "success" : "failure",
  confidence: 1,
  evidence: ok ? "postcondition holds" : "postcondition failed",
});

const REFUSAL = /\b(no puedo ayudar|no puedo hacer eso|lo siento,? pero no puedo|i can'?t help|i cannot assist|i'?m sorry,? but i can'?t|as an ai (language )?model)\b/i;
const NEEDS_SUBSTANCE: ReadonlySet<TaskType> = new Set(["coding", "debugging", "research", "agentic_project"]);
const NEEDS_CODE: ReadonlySet<TaskType> = new Set(["coding", "debugging"]);

/**
 * Free, deterministic sanity checks on a response. It can prove a response is broken or suspicious,
 * never that it is correct, so a pass is only `success` with modest confidence.
 */
export class ResponseHeuristicEvaluator implements Evaluator {
  readonly name = "response_heuristics";

  evaluate({ taskType, response, failure }: EvalInput): Verdict {
    const v = (outcome: Outcome, confidence: number, evidence: string): Verdict => ({ evaluator: this.name, outcome, confidence, evidence });
    const text = response.trim();

    if (failure) return v("failure", 1, failure);
    if (!text) return v("failure", 1, "empty response");

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    let run = 1;
    for (let i = 1; i < lines.length; i++) {
      run = lines[i] === lines[i - 1] ? run + 1 : 1;
      if (run >= 6) return v("failure", 0.9, "degenerate repetition");
    }

    if (REFUSAL.test(text.slice(0, 300))) return v("uncertain", 0.4, "response looks like a refusal");
    if (NEEDS_SUBSTANCE.has(taskType) && text.length < 40) return v("uncertain", 0.4, "response too short for this task type");
    if (NEEDS_CODE.has(taskType) && !/```|[{};=]|\bdef\b|\bfunction\b/.test(text)) return v("uncertain", 0.5, "coding task without any code in the answer");
    return v("success", 0.6, "passed heuristic checks");
  }
}

export type CodeTestRunner = (code: string) => Promise<{ passed: boolean; output: string }>;

const FENCE = /```[^\n`]*\n([\s\S]*?)```/;

/**
 * Runs the first code block of a coding answer through an injected test runner. Executing model-written
 * code needs a sandbox, so no runner ships in the live sidecar; the Phase 3 harness provides one.
 */
export class CodeTestsEvaluator implements Evaluator {
  readonly name = "code_tests";
  constructor(private readonly run: CodeTestRunner) {}

  async evaluate({ taskType, response }: EvalInput): Promise<Verdict | undefined> {
    if (!NEEDS_CODE.has(taskType)) return undefined;
    const code = FENCE.exec(response)?.[1];
    if (!code) return { evaluator: this.name, outcome: "uncertain", confidence: 0.3, evidence: "no code block to test" };
    try {
      const r = await this.run(code);
      return { evaluator: this.name, outcome: r.passed ? "success" : "failure", confidence: 1, evidence: r.output.slice(0, 500) };
    } catch (e) {
      return { evaluator: this.name, outcome: "uncertain", confidence: 0.3, evidence: `test runner error: ${(e as Error).message}` };
    }
  }
}

const SEVERITY: Record<Outcome, number> = { success: 0, uncertain: 1, failure: 2 };

/** Runs every applicable evaluator; the worst outcome wins, confidence is the minimum, costs add up. */
export async function runEvaluators(evaluators: readonly Evaluator[], input: EvalInput): Promise<Verdict | undefined> {
  const verdicts: Verdict[] = [];
  for (const e of evaluators) {
    const v = await e.evaluate(input);
    if (v) verdicts.push(v);
  }
  if (verdicts.length === 0) return undefined;
  const worst = verdicts.reduce((a, b) => (SEVERITY[b.outcome] > SEVERITY[a.outcome] ? b : a));
  const usages = verdicts.map((v) => v.usage).filter((u): u is Usage => !!u);
  const usage: Usage | undefined = usages.length
    ? usages.reduce((a, b) => ({
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
        estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
        latencyMs: a.latencyMs + b.latencyMs,
      }))
    : undefined;
  return {
    evaluator: verdicts.map((v) => v.evaluator).join("+"),
    outcome: worst.outcome,
    confidence: Math.min(...verdicts.map((v) => v.confidence)),
    evidence: worst.evidence,
    ...(usage ? { usage } : {}),
  };
}
