import { OrchestratorEvent } from "@jarvis/protocol";
import type { EventBody, Scenario } from "./scenarios";

type Listener = (event: OrchestratorEvent) => void;

export interface PlayerOptions {
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Replays a scripted scenario as a stream of OrchestratorEvents. Every event is validated
 * against the real protocol schema, so the demo cannot drift from the contract. It pauses
 * at `permission.required` until the user answers. Stands in for the real orchestrator
 * until Phase 1; the UI consumes it exactly like a live event source.
 */
export class DemoPlayer {
  private listeners = new Set<Listener>();
  private runId = 0;
  private seq = 0;
  private resolver?: (granted: boolean) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: PlayerOptions = {}) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  stop(): void {
    this.runId++;
    this.resolver?.(false);
    this.resolver = undefined;
  }

  resolvePermission(granted: boolean): void {
    this.resolver?.(granted);
  }

  async play(scenario: Scenario): Promise<void> {
    this.stop();
    const run = this.runId;
    const taskId = `${scenario.id}-${this.now()}`;
    this.seq = 0;
    let answer: "granted" | "denied" | undefined;

    for (const step of scenario.steps) {
      if (step.when && step.when !== answer) continue;
      await this.sleep(step.delay);
      if (run !== this.runId) return;

      this.emit(taskId, step.event);

      if (step.event.type === "permission.required") {
        const requestId = step.event.requestId;
        const granted = await new Promise<boolean>((resolve) => (this.resolver = resolve));
        this.resolver = undefined;
        if (run !== this.runId) return;
        answer = granted ? "granted" : "denied";
        this.emit(taskId, { type: "permission.resolved", requestId, granted });
      }
    }
  }

  private emit(taskId: string, body: EventBody): void {
    const seq = this.seq++;
    const event = OrchestratorEvent.parse({ ...body, id: `${taskId}#${seq}`, taskId, seq, ts: this.now() });
    this.listeners.forEach((l) => l(event));
  }
}
