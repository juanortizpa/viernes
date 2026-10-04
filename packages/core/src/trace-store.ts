import type { ExecutionTrace } from "@jarvis/protocol";

/** Persistence boundary; SQLite implementation lands in a later Phase 1 slice (ADR-0007). */
export interface TraceStore {
  save(trace: ExecutionTrace): void | Promise<void>;
  /** Most recent first. Optional: stores that cannot list simply have no economy panel. */
  list?(limit?: number): ExecutionTrace[];
}

export class MemoryTraceStore implements TraceStore {
  readonly traces: ExecutionTrace[] = [];
  save(trace: ExecutionTrace): void {
    this.traces.push(trace);
  }
  list(limit = 100): ExecutionTrace[] {
    return this.traces.slice(-limit).reverse();
  }
}
