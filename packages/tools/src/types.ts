import type { z } from "zod";
import type { PermissionLevel, Provenance, ToolDescriptor } from "@jarvis/protocol";

export interface ToolContext {
  taskId: string;
  signal?: AbortSignal;
  /** Report REAL intermediate progress (it becomes a `progress` OrchestratorEvent). Never call it for work not yet done. */
  progress?: (stage: string, detail?: string) => void;
}

export interface ToolResult<O = unknown> {
  ok: boolean;
  summary: string;
  output?: O;
  /** Where the output came from; untrusted_external taints the task (ADR-0005). */
  provenance: Provenance;
}

/** Undo handle taken before a side-effecting run. `restore` throws if the world changed so that undoing would be unsafe. */
export interface Checkpoint {
  description: string;
  restore(): Promise<void>;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  risk: PermissionLevel;
  reversible: boolean;
  /**
   * False hides the tool from the model and refuses it if the model asks anyway: it is only for the user's own commands
   * (local intents). Used for everything that edits what the assistant keeps about the user, so that injected text in a web
   * page or file can never change it (ADR-0005, ADR-0023). Defaults to true.
   */
  modelCallable?: boolean;
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
  /** Snapshot taken just before `run` so the orchestrator can roll back and escalate. A tool above `read` risk without one is treated as irreversible. */
  checkpoint?(input: I, ctx: ToolContext): Promise<Checkpoint>;
  /** Postcondition check; its presence makes the tool `verifiable`. */
  verify?(input: I, result: ToolResult<O>, ctx: ToolContext): Promise<boolean>;
}

export type AnyTool = Tool<any, any>;
export type { ToolDescriptor };
