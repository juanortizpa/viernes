import { compareRisk, type PermissionLevel, type PolicyDecision } from "@jarvis/protocol";
import { MemoryAuditLog, type AuditSink } from "./audit";

export interface PolicyRequest {
  taskId: string;
  tool: string;
  risk: PermissionLevel;
  /** True once any untrusted_external content entered the task's context (ADR-0005). */
  tainted: boolean;
}

export interface PolicyConfig {
  /** Tools that never run. */
  denyTools?: ReadonlySet<string>;
  /** `sensitive` tools the user pre-approved. Never applies to `critical`, nor to tainted tasks. */
  allowSensitive?: ReadonlySet<string>;
  now?: () => number;
}

/**
 * Deterministic policy engine (ADR-0005). The LLM proposes; this decides.
 * No model output is consulted here, only the tool's declared risk and the taint flag.
 */
export class PolicyEngine {
  constructor(
    private readonly config: PolicyConfig = {},
    private readonly audit: AuditSink = new MemoryAuditLog(),
  ) {}

  decide(req: PolicyRequest): PolicyDecision {
    const decision = this.compute(req);
    this.audit.record({
      ts: (this.config.now ?? Date.now)(),
      taskId: req.taskId,
      tool: req.tool,
      risk: req.risk,
      tainted: req.tainted,
      decision,
    });
    return decision;
  }

  /** Record the user's answer to a `confirm` decision. */
  recordGrant(req: PolicyRequest, granted: boolean): void {
    this.audit.record({
      ts: (this.config.now ?? Date.now)(),
      taskId: req.taskId,
      tool: req.tool,
      risk: req.risk,
      tainted: req.tainted,
      decision: { action: "confirm", reason: "user_response" },
      granted,
    });
  }

  private compute({ tool, risk, tainted }: PolicyRequest): PolicyDecision {
    if (this.config.denyTools?.has(tool)) return { action: "deny", reason: `tool "${tool}" is denied by configuration` };
    if (risk === "critical") return { action: "confirm", reason: "critical actions always need explicit confirmation" };
    if (compareRisk(risk, "sensitive") >= 0) {
      if (tainted) {
        return { action: "confirm", reason: "task read untrusted external content; sensitive action needs confirmation" };
      }
      if (this.config.allowSensitive?.has(tool)) return { action: "allow" };
      return { action: "confirm", reason: "sensitive action needs confirmation" };
    }
    return { action: "allow" };
  }
}
