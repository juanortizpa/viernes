import type { PermissionLevel, PolicyDecision } from "@jarvis/protocol";

export interface AuditEntry {
  ts: number;
  taskId: string;
  tool: string;
  risk: PermissionLevel;
  tainted: boolean;
  decision: PolicyDecision;
  /** Filled in after the user answers a `confirm` decision. */
  granted?: boolean;
}

export interface AuditSink {
  record(entry: AuditEntry): void;
}

export class MemoryAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}
