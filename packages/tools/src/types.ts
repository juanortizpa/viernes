import type { z } from "zod";
import type { PermissionLevel, Provenance, ToolDescriptor } from "@jarvis/protocol";

export interface ToolContext {
  taskId: string;
  signal?: AbortSignal;
}

export interface ToolResult<O = unknown> {
  ok: boolean;
  summary: string;
  output?: O;
  /** Where the output came from; untrusted_external taints the task (ADR-0005). */
  provenance: Provenance;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  risk: PermissionLevel;
  reversible: boolean;
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
  /** Postcondition check; its presence makes the tool `verifiable`. */
  verify?(input: I, result: ToolResult<O>, ctx: ToolContext): Promise<boolean>;
}

export type AnyTool = Tool<any, any>;
export type { ToolDescriptor };
