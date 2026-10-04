import type { ExecutionTrace } from "@jarvis/protocol";

/** Persistence boundary; SQLite implementation lands in a later Phase 1 slice (ADR-0007). */
export interface TraceStore {
  save(trace: ExecutionTrace): void | Promise<void>;
}

export class MemoryTraceStore implements TraceStore {
  readonly traces: ExecutionTrace[] = [];
  save(trace: ExecutionTrace): void {
    this.traces.push(trace);
  }
}
