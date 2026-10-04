import { OrchestratorEvent } from "@jarvis/protocol";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventDraft = DistributiveOmit<OrchestratorEvent, "id" | "taskId" | "seq" | "ts">;
export type EventListener = (e: OrchestratorEvent) => void;

/** The single stream for UI and telemetry (ADR-0004). */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(l: EventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  publish(e: OrchestratorEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/** Stamps ids/seq/ts, validates against the protocol, then publishes. Invalid events throw. */
export class TaskEmitter {
  private seq = 0;
  constructor(
    private readonly taskId: string,
    private readonly bus: EventBus,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

  emit(draft: EventDraft): OrchestratorEvent {
    const event = OrchestratorEvent.parse({ ...draft, id: this.newId(), taskId: this.taskId, seq: this.seq++, ts: this.now() });
    this.bus.publish(event);
    return event;
  }
}
