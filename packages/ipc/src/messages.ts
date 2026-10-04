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
  /**
   * Streaming voice (ADR-0029): audio flows WHILE the user talks, so the sidecar transcribes partials and can start thinking before
   * the end. Chunks are base64 PCM16 little-endian mono at 16 kHz (~200 ms each). `end` = the user stopped (key released or the
   * endpointer fired); the reply is the usual `voice.transcribed` + task, or `voice.rejected`. One stream at a time per connection.
   */
  z.object({ type: z.literal("voice.stream.start"), id: z.string().min(1).max(40), language: z.string().regex(/^(auto|[a-z]{2,3})$/).optional() }),
  z.object({ type: z.literal("voice.stream.chunk"), id: z.string().min(1).max(40), pcm: z.string().min(4).max(200_000) }),
  z.object({ type: z.literal("voice.stream.end"), id: z.string().min(1).max(40) }),
  z.object({ type: z.literal("voice.stream.cancel"), id: z.string().min(1).max(40) }),

  /** Aggregate of the most recent stored traces, for the AI Economy panel. */
  z.object({ type: z.literal("economy.get"), limit: z.number().int().min(1).max(5000).default(500) }),
  /**
   * The user's own view and control of long-term memory (ADR-0023): every change is answered with a fresh `memory` message.
   * These come from the user's clicks; the model has no way to send them.
   */
  z.object({ type: z.literal("memory.get") }),
  z.object({ type: z.literal("memory.forget"), id: z.string().min(1).max(64) }),
  z.object({ type: z.literal("memory.clear") }),
  z.object({ type: z.literal("memory.toggle"), enabled: z.boolean() }),
  /** Cancels every active task of this connection. */
  z.object({ type: z.literal("task.cancel") }),
  z.object({ type: z.literal("permission.answer"), requestId: z.string(), granted: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const MemoryItemView = z.object({
  id: z.string(),
  kind: z.enum(["fact", "preference"]),
  text: z.string(),
  createdAt: z.number(),
  /** Last time it was put into a prompt; absent if never. */
  usedAt: z.number().optional(),
  uses: z.number().int().nonnegative(),
});
export type MemoryItemView = z.infer<typeof MemoryItemView>;

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
    /** Speech engines in the order they are tried, e.g. ["groq:whisper-large-v3-turbo", "local"]. A "groq:" engine sends audio to Groq. */
    voiceEngines: z.array(z.string()).default([]),
    /** The sidecar accepts `voice.stream.*` (ADR-0029). */
    streaming: z.boolean().default(false),
  }),
  /** What has been understood so far, while the user is still talking (live caption). Never acted on by itself. */
  z.object({
    type: z.literal("voice.partial"),
    id: z.string(),
    text: z.string(),
    /** Semantic end of turn: this partial heard every word and reads as a finished sentence, so the turn may close early. */
    turnEnd: z.boolean().default(false),
  }),
  /** Reply to every `memory.*` message: what is remembered, and whether memory is on. `conversationTurns` is the working memory of the current chat. */
  z.object({ type: z.literal("memory"), enabled: z.boolean(), conversationTurns: z.number().int().nonnegative(), items: z.array(MemoryItemView) }),
  /** Reply to `economy.get`; `summary` is absent when the trace store cannot be listed. */
  z.object({ type: z.literal("economy"), summary: EconomySummary.optional() }),
  z.object({
    type: z.literal("wake.result"),
    detected: z.boolean(),
    /** The utterance also held a command and it was already submitted (a `voice.transcribed` came first). */
    commandRan: z.boolean(),
    reason: z.enum(["unavailable", "failed", "cancelled"]).optional(),
  }),
  z.object({
    type: z.literal("voice.transcribed"),
    text: z.string(),
    audioMs: z.number(),
    latencyMs: z.number(),
    language: z.string().optional(),
    engine: z.string().optional(),
    /** Literal words when `text` is an interpretation (misrecognitions fixed). */
    heard: z.string().optional(),
    /** Streaming only: ms from the end of the audio to this transcript (0 when a partial taken during the pause was reused). */
    afterEndMs: z.number().optional(),
    /** Streaming only: an answer had already been started on these exact words while the user was talking. */
    speculated: z.boolean().optional(),
  }),
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
