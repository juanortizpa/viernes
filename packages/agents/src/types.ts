/** A coding agent run in one project folder (ADR-0024). */
export interface AgentRunOptions {
  /** Full prompt for the agent (built by the chain). Sent on stdin, never on the command line. */
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  /** Real progress taken from the agent's own event stream. */
  onProgress?: (stage: string, detail?: string) => void;
  /** Hard limit for the whole run. */
  timeoutMs?: number;
  /** Abort when the agent emits nothing for this long (e.g. stuck retrying a 503). */
  idleTimeoutMs?: number;
}

export interface AgentResult {
  /** The agent itself reported success. (The chain may still verify independently.) */
  ok: boolean;
  /** The agent's final message (what it says it did), trimmed. */
  summary: string;
  /** Why it is not ok, in plain words. */
  failure?: string;
  /** How the process ended. */
  stoppedBy: "exit" | "timeout" | "idle" | "cancel" | "spawn-error";
  /** Quota or plan limit hit: escalate, do not retry this agent. */
  limited?: boolean;
  /** Files the agent reported touching (from its tool events). */
  touched: string[];
}

export interface CodingAgent {
  readonly name: string;
  run(o: AgentRunOptions): Promise<AgentResult>;
}
