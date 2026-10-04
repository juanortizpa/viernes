import type { ModelCapabilities } from "@jarvis/protocol";
import type { ProviderRegistry } from "@jarvis/providers";
import { grade } from "./checks";
import { mulberry32 } from "./stats";
import type { CellTable } from "./table";
import type { Cell, EvalTask } from "./types";

const SYSTEM = "You are a precise assistant. Follow the requested output format exactly and add nothing else.";

export interface RunOptions {
  tasks: EvalTask[];
  models: ModelCapabilities[];
  providers: ProviderRegistry;
  table: CellTable;
  concurrency?: number;
  /** Output budget per call; reasoning models spend part of it thinking. */
  maxTokens?: number;
  /** Extra attempts for transport errors (rate limits, 5xx) before an error cell is recorded. */
  retries?: number;
  backoffMs?: number;
  /** Stop after this many API calls in this invocation (free tiers allow ~50/day); the table resumes next time. */
  budget?: number;
  /** Tasks are visited in a seeded random order so a run cut short by a quota still covers a representative subset. */
  seed?: number;
  onCell?: (cell: Cell, done: number, total: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

async function callOnce(opts: RunOptions, task: EvalTask, caps: ModelCapabilities): Promise<{ text: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const provider = opts.providers.get(caps.provider);
  if (!provider) throw new Error(`provider not registered: ${caps.provider}`);
  const t0 = (opts.now ?? Date.now)();
  let text = "";
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  for await (const chunk of provider.generate({ model: caps.model, system: SYSTEM, messages: [{ role: "user", content: task.prompt }], maxTokens: opts.maxTokens ?? 2048 })) {
    if (chunk.type === "delta") text += chunk.text;
    else if (chunk.type === "done") usage = chunk.usage;
  }
  if (!usage) throw new Error("provider ended without usage");
  return { text, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: (opts.now ?? Date.now)() - t0 };
}

/** A daily quota is not a transient error: retrying only burns the little that is left, so the run stops cleanly. */
export const isDailyQuotaError = (message: string): boolean => /per-day|daily/i.test(message) && /rate limit|quota|429/i.test(message);

/**
 * Fill the counterfactual table: every model on every task, once (ADR-0013). The response is stored so a
 * grader or evaluator can be changed later without calling any API again.
 */
export async function runCounterfactual(opts: RunOptions): Promise<{ computed: number; errors: number; skipped: number; stopped?: "quota" | "budget" }> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const rand = mulberry32(opts.seed ?? 1);
  const order = opts.tasks.map((t) => ({ t, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.t);
  const jobs = order.flatMap((task) => opts.models.map((caps) => ({ task, caps }))).filter((j) => !opts.table.hasResult(j.task.id, j.caps.model));
  const skipped = opts.tasks.length * opts.models.length - jobs.length;
  let done = 0;
  let errors = 0;
  let next = 0;
  let calls = 0;
  let stopped: "quota" | "budget" | undefined;

  const worker = async (): Promise<void> => {
    for (let j = jobs[next++]; j && !stopped; j = jobs[next++]) {
      if (opts.budget !== undefined && calls >= opts.budget) {
        stopped = "budget";
        break;
      }
      const { task, caps } = j;
      let cell: Cell | undefined;
      let lastError = "";
      for (let attempt = 0; attempt <= (opts.retries ?? 3) && !cell; attempt++) {
        try {
          calls++;
          const r = await callOnce(opts, task, caps);
          const g = await grade(task, r.text);
          cell = { taskId: task.id, model: caps.model, response: r.text, pass: g.pass, detail: g.detail, inputTokens: r.inputTokens, outputTokens: r.outputTokens, latencyMs: r.latencyMs, ts: now() };
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          if (isDailyQuotaError(lastError)) {
            stopped = "quota";
            lastError = "";
            break;
          }
          if (attempt < (opts.retries ?? 3)) await sleep((opts.backoffMs ?? 2000) * 2 ** attempt);
        }
      }
      if (!cell && stopped === "quota") break; // no evidence about the model: leave the cell missing
      if (!cell) {
        errors++;
        cell = { taskId: task.id, model: caps.model, response: "", pass: false, detail: "transport error", inputTokens: 0, outputTokens: 0, latencyMs: 0, error: lastError.slice(0, 300), ts: now() };
      }
      opts.table.add(cell);
      done++;
      opts.onCell?.(cell, done, jobs.length);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, jobs.length || 1)) }, worker));
  return { computed: done - errors, errors, skipped, ...(stopped ? { stopped } : {}) };
}
