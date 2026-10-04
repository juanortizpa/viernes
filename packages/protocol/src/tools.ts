import { z } from "zod";
import { PermissionLevel } from "./common";

/**
 * Serializable metadata for a tool. The executable `run`/`verify` functions live in
 * packages/tools and are not part of the wire protocol.
 */
export const ToolDescriptor = z.object({
  name: z.string(),
  description: z.string(),
  risk: PermissionLevel,
  /** Can the effect be undone (or was a checkpoint taken)? Gates automatic escalation re-runs. */
  reversible: z.boolean(),
  /** Does the tool have a postcondition check (`verify`)? */
  verifiable: z.boolean(),
  /** JSON Schema of the input. */
  inputSchema: z.record(z.unknown()),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

export const PolicyDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("allow") }),
  z.object({ action: z.literal("confirm"), reason: z.string() }),
  z.object({ action: z.literal("deny"), reason: z.string() }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;
