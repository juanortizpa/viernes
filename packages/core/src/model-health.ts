import type { ModelCapabilities } from "@jarvis/protocol";

/**
 * Online latency/availability model per model (ADR-0029). Learned from every real attempt, no training step:
 * - Cooldown: a 429 (quota) or 5xx keeps the model out of routing for a while, so a voice request does not first wait on a
 *   model that is known to refuse (measured: the free OpenRouter model answered 429 on EVERY request, costing 80-350 ms each).
 * - Time to first token: an exponentially weighted mean, used to tell the user how long to expect and to prefer fast models
 *   when speed matters.
 */
export interface HealthSample {
  ok: boolean;
  /** Time to first token of a successful call. */
  ttftMs?: number;
  /** HTTP status of a failed call, if known. */
  status?: number;
  /** Server-provided Retry-After. */
  retryAfterMs?: number;
}

interface Entry {
  ttft?: number;
  samples: number;
  coolUntil: number;
  /** Consecutive failures: the cooldown grows with them. */
  strikes: number;
}

export class ModelHealth {
  private readonly m = new Map<string, Entry>();

  constructor(private readonly opts: { now?: () => number; alpha?: number } = {}) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private entry(model: string): Entry {
    let e = this.m.get(model);
    if (!e) this.m.set(model, (e = { samples: 0, coolUntil: 0, strikes: 0 }));
    return e;
  }

  record(model: string, s: HealthSample): void {
    const e = this.entry(model);
    if (s.ok) {
      e.strikes = 0;
      e.coolUntil = 0;
      if (s.ttftMs !== undefined && Number.isFinite(s.ttftMs)) {
        const a = this.opts.alpha ?? 0.3;
        e.ttft = e.ttft === undefined ? s.ttftMs : a * s.ttftMs + (1 - a) * e.ttft;
        e.samples++;
      }
      return;
    }
    // Only failures that say "try later" cool a model down; a 400 for one prompt says nothing about the next one.
    const transient = s.status === 429 || s.status === 408 || s.status === 503 || s.status === 502 || s.status === 500 || s.status === 504 || s.status === undefined;
    if (!transient) return;
    e.strikes++;
    const base = s.status === 429 ? 60_000 : 15_000;
    const backoff = Math.min(15 * 60_000, base * 2 ** (e.strikes - 1));
    e.coolUntil = this.now() + Math.max(s.retryAfterMs ?? 0, backoff);
  }

  coolingDown(model: string): boolean {
    return (this.m.get(model)?.coolUntil ?? 0) > this.now();
  }

  /** Models that are not cooling down; all of them if every one is (better a slow try than no answer). */
  available(caps: ModelCapabilities[]): ModelCapabilities[] {
    const ok = caps.filter((c) => !this.coolingDown(c.model));
    return ok.length > 0 ? ok : caps;
  }

  /** Learned time to first token, or the configured estimate until there is data. */
  expectedTtftMs(c: Pick<ModelCapabilities, "model" | "expectedLatency">): number {
    const e = this.m.get(c.model);
    return e?.ttft ?? (c.expectedLatency > 0 ? c.expectedLatency : 800);
  }

  snapshot(): { model: string; ttftMs?: number; samples: number; coolingForMs: number }[] {
    const t = this.now();
    return [...this.m.entries()].map(([model, e]) => ({ model, ...(e.ttft !== undefined ? { ttftMs: Math.round(e.ttft) } : {}), samples: e.samples, coolingForMs: Math.max(0, e.coolUntil - t) }));
  }
}
