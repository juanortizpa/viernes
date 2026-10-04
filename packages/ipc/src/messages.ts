import { z } from "zod";
import { OrchestratorEvent } from "@jarvis/protocol";

export const IPC_VERSION = 1 as const;

/** UI/shell -> sidecar. The first message on a connection must be `hello` with the session token. */
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token: z.string(), protocol: z.literal(IPC_VERSION) }),
  z.object({
    type: z.literal("task.submit"),
    input: z.string().min(1).max(10_000),
    modality: z.enum(["text", "voice"]).default("text"),
  }),
  /** Cancels every active task of this connection. */
  z.object({ type: z.literal("task.cancel") }),
  z.object({ type: z.literal("permission.answer"), requestId: z.string(), granted: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Sidecar -> UI/shell. `event` carries the one stream the UI renders from (ADR-0004). */
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello.ok"),
    protocol: z.literal(IPC_VERSION),
    models: z.array(z.string()),
    /** True when no real provider is configured and replies come from the local offline echo. */
    offline: z.boolean(),
  }),
  z.object({ type: z.literal("hello.error"), message: z.string() }),
  z.object({ type: z.literal("event"), event: OrchestratorEvent }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
