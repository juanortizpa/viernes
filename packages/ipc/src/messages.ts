import { z } from "zod";
import { EconomySummary, OrchestratorEvent } from "@jarvis/protocol";

export const IPC_VERSION = 1 as const;

/** UI/shell -> sidecar. The first message on a connection must be `hello` with the session token. */
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token: z.string(), protocol: z.literal(IPC_VERSION) }),
  z.object({
    type: z.literal("task.submit"),
    input: z.string().min(1).max(10_000),
    modality: z.enum(["text", "voice"]).default("text"),
  }),
  /**
   * Push-to-talk clip: base64 of a PCM16 WAV (<= 20 s). The sidecar transcribes it locally, answers with `voice.transcribed`,
   * then runs the text as a voice task. Silence and unusable clips come back as `voice.rejected` and never reach the engine.
   */
  z.object({ type: z.literal("voice.submit"), audio: z.string().min(100).max(1_600_000), language: z.string().regex(/^(auto|[a-z]{2,3})$/).optional() }),
  /**
   * Wake-word stage 2: an utterance the on-device spotter liked. The sidecar transcribes it, checks that it starts with the wake
   * word and answers `wake.result`. If something follows the wake word ("jarvis abre la calculadora") that part is run as a voice
   * task right away. Utterances that are not for the assistant are discarded: their text is never stored, logged or sent back.
   */
  z.object({ type: z.literal("wake.verify"), audio: z.string().min(100).max(1_600_000) }),
  /** Aggregate of the most recent stored traces, for the AI Economy panel. */
  z.object({ type: z.literal("economy.get"), limit: z.number().int().min(1).max(5000).default(500) }),
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
    /** A speech-to-text engine is configured, so push-to-talk can work. */
    voice: z.boolean().default(false),
  }),
  /** Reply to `economy.get`; `summary` is absent when the trace store cannot be listed. */
  z.object({ type: z.literal("economy"), summary: EconomySummary.optional() }),
  z.object({
    type: z.literal("wake.result"),
    detected: z.boolean(),
    /** The utterance also held a command and it was already submitted (a `voice.transcribed` came first). */
    commandRan: z.boolean(),
    reason: z.enum(["unavailable", "failed", "cancelled"]).optional(),
  }),
  z.object({ type: z.literal("voice.transcribed"), text: z.string(), audioMs: z.number(), latencyMs: z.number(), language: z.string().optional() }),
  z.object({
    type: z.literal("voice.rejected"),
    reason: z.enum(["invalid", "too_short", "too_long", "silence", "empty", "unavailable", "failed", "cancelled"]),
    message: z.string(),
  }),
  z.object({ type: z.literal("hello.error"), message: z.string() }),
  z.object({ type: z.literal("event"), event: OrchestratorEvent }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
