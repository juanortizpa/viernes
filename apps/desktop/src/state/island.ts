import type { OrchestratorEvent, PermissionLevel } from "@jarvis/protocol";

/** Visual state of both the island and the raven. The raven is a pure function of `mode`. */
export type Mode = "idle" | "listening" | "thinking" | "executing" | "permission" | "success" | "error" | "warning";

export interface PendingPermission {
  requestId: string;
  tool: string;
  risk: PermissionLevel;
  reason: string;
}

export interface IslandState {
  mode: Mode;
  headline: string;
  detail?: string;
  /** Only set from `progress` events that carry a real fraction. */
  fraction?: number;
  route?: "local" | "llm";
  model?: string;
  pending?: PendingPermission;
  tokens: number;
  costUsd: number;
  escalations: number;
  /** Real microphone level (0..1) while recording; undefined otherwise. */
  level?: number;
  /** The speech synthesiser is really playing audio. */
  speaking?: boolean;
  /** Earlier turns and saved memories that really went into this request's prompt (from `context.used`). */
  context?: { turns: number; memories: number };
  /** The model's answer of the current attempt, as streamed; shown when the task finishes without a summary. */
  answer?: string;
  /** Hands-free listening: what the always-on loop is really doing. Undefined/off = the microphone is closed. */
  wake?: { state: "off" | "idle" | "verifying" | "command" | "busy" | "followUp"; /** ms left in the follow-up window */ followUpMs?: number };
}

export const initialState: IslandState = {
  mode: "idle",
  headline: "JARVIS",
  tokens: 0,
  costUsd: 0,
  escalations: 0,
};

/** Voice actions mirror what the microphone and the STT engine are really doing; they are not orchestrator progress. */
export type IslandAction =
  | { kind: "event"; event: OrchestratorEvent }
  | { kind: "reset" }
  | { kind: "voice.preparing" }
  | { kind: "voice.recording" }
  | { kind: "voice.level"; level: number }
  | { kind: "voice.transcribing" }
  /** Live caption: what the sidecar has understood so far while the user is still talking (ADR-0029). Not an action. */
  | { kind: "voice.partial"; text: string }
  | { kind: "voice.heard"; text: string; /** e.g. "groq:whisper-large-v3-turbo" */ engine?: string; /** literal words when `text` was interpreted */ heard?: string }
  | { kind: "voice.rejected"; message: string }
  | { kind: "speech"; speaking: boolean }
  | { kind: "wake"; state: "off" | "idle" | "verifying" | "command" | "busy" | "followUp"; followUpMs?: number };

/**
 * Pure reducer: OrchestratorEvent -> island state. This is the ONLY way the UI learns what
 * JARVIS is doing (ADR-0004), so nothing here can show progress that did not happen.
 */
export function islandReducer(state: IslandState, action: IslandAction): IslandState {
  switch (action.kind) {
    case "reset": {
      const base = { ...initialState, speaking: state.speaking, wake: state.wake };
      // Collapsing after a task must not hide that the follow-up window / command prompt is still open.
      if (state.wake?.state === "command" || state.wake?.state === "followUp") return { ...base, mode: "listening", headline: state.wake.state === "command" ? "Dime…" : "Te escucho…", level: 0 };
      return base;
    }
    case "wake": {
      const wake = { state: action.state, followUpMs: action.followUpMs };
      // Waiting for the user to talk (after the wake word, or in the follow-up window) is "listening"; leaving it releases the pose.
      const waiting = action.state === "command" || action.state === "followUp";
      if (waiting && state.mode === "idle") return { ...state, wake, mode: "listening", headline: action.state === "command" ? "Dime…" : "Te escucho…", detail: undefined, level: 0 };
      if (!waiting && state.mode === "listening" && !state.pending && state.headline !== "Escuchando…") return { ...state, wake, mode: "idle", headline: initialState.headline, detail: undefined, level: undefined };
      return { ...state, wake };
    }
    case "speech":
      return { ...state, speaking: action.speaking };
    case "voice.preparing":
      // The microphone is still opening: anything said now would be lost, so do not claim to be listening yet.
      return { ...initialState, mode: "thinking", headline: "Preparando micrófono…", detail: "Espera a ver «Escuchando…» para hablar", speaking: state.speaking, wake: state.wake };
    case "voice.recording":
      return { ...initialState, mode: "listening", headline: "Escuchando…", detail: "Suelta para enviar", level: 0, speaking: state.speaking, wake: state.wake };
    case "voice.level":
      return state.mode === "listening" ? { ...state, level: action.level } : state;
    case "voice.partial":
      // Only while the user is talking or the last words are being transcribed: a late caption never overwrites an answer.
      return state.mode === "listening" || (state.mode === "thinking" && state.headline === "Transcribiendo…") ? { ...state, detail: `«${action.text}»` } : state;
    case "voice.transcribing":
      return { ...state, mode: "thinking", headline: "Transcribiendo…", detail: undefined, level: undefined };
    case "voice.heard":
      // Show what was understood; when it was interpreted (misrecognitions fixed), show what was literally heard too.
      return {
        ...state,
        mode: "thinking",
        headline: action.heard ? "Entendí" : action.engine && action.engine !== "local" ? "Escuché (nube)" : "Escuché",
        detail: action.heard ? `${action.text} · (oí: «${action.heard}»)` : action.text,
        level: undefined,
      };
    case "voice.rejected":
      return { ...initialState, mode: "warning", headline: action.message, speaking: state.speaking, wake: state.wake };
  }
  const e = action.event;

  switch (e.type) {
    case "task.started":
      return { ...initialState, mode: "thinking", headline: "Pensando…", detail: e.input, speaking: state.speaking, wake: state.wake };

    case "intent.resolved":
      return e.route === "local"
        ? { ...state, route: "local", mode: "executing", headline: "Acción local", detail: e.intent }
        : { ...state, route: "llm", mode: "thinking", headline: "Eligiendo modelo…" };

    case "instant.issued":
      // Receipt or pleasantry from the deterministic instant layer; the UI says so rather than pretending a model spoke.
      return e.kind === "ack"
        ? { ...state, mode: "thinking", headline: "Recibido", detail: e.text }
        : { ...state, route: "local", mode: "thinking", headline: e.kind === "cache" ? "Respuesta guardada" : "Respuesta rápida", detail: e.text };

    case "context.used":
      return { ...state, context: { turns: e.conversationTurns, memories: e.memories.length } };

    case "route.decided":
      return {
        ...state,
        mode: "thinking",
        model: e.decision.model,
        headline: e.decision.model ? `Usando ${e.decision.model}` : state.headline,
        detail: e.decision.rationale,
        answer: undefined,
      };

    case "progress":
      return { ...state, mode: "executing", headline: e.stage, detail: e.detail, fraction: e.fraction ?? state.fraction };

    case "tool.requested":
      return { ...state, mode: "executing", headline: `Ejecutando ${e.tool}`, detail: e.summary };

    case "permission.required":
      return {
        ...state,
        mode: "permission",
        headline: "Necesito tu permiso",
        detail: e.reason,
        pending: { requestId: e.requestId, tool: e.tool, risk: e.risk, reason: e.reason },
      };

    case "permission.resolved":
      return e.granted
        ? { ...state, mode: "executing", pending: undefined, headline: "Permiso concedido" }
        : { ...state, mode: "warning", pending: undefined, headline: "Acción denegada" };

    case "tool.completed":
      return e.ok
        ? { ...state, mode: "executing", detail: e.summary ?? state.detail }
        : { ...state, mode: "warning", headline: `${e.tool} falló`, detail: e.summary };

    case "response.delta":
      // A fresh answer starts a fresh line: the previous detail was a rationale, a reason or an abandoned attempt.
      return {
        ...state,
        mode: "thinking",
        headline: "Respondiendo…",
        detail: ((state.headline === "Respondiendo…" ? (state.detail ?? "") : "") + e.text).slice(-140),
        answer: ((state.answer ?? "") + e.text).slice(0, 4000),
      };

    case "model.completed":
      return {
        ...state,
        tokens: state.tokens + e.usage.inputTokens + e.usage.outputTokens,
        costUsd: state.costUsd + e.usage.estimatedCostUsd,
      };

    case "eval.completed":
      return e.verdict.outcome === "failure"
        ? { ...state, mode: "warning", headline: "Verificación fallida", detail: e.verdict.evidence }
        : { ...state, headline: "Verificado", detail: e.verdict.evidence };

    case "checkpoint.restored":
      return { ...state, mode: "warning", headline: e.ok ? "Deshaciendo cambios" : "No pude deshacer un cambio", detail: e.summary };

    case "escalated":
      return {
        ...state,
        mode: "warning",
        headline: `Escalando a ${e.to}`,
        detail: e.reason,
        model: e.to,
        escalations: state.escalations + 1,
        answer: undefined, // the abandoned attempt's text is not the answer
      };

    case "task.finished":
      // Model answers carry no summary: the island keeps showing what was really answered instead of going blank.
      if (e.outcome === "success") return { ...state, mode: "success", headline: "Listo", detail: e.summary ?? (state.answer?.trim() || undefined), fraction: undefined, pending: undefined };
      if (e.outcome === "failure") return { ...state, mode: "error", headline: "No pude completarlo", detail: e.summary, pending: undefined };
      return { ...state, mode: "idle", headline: "Cancelado", detail: e.summary, pending: undefined };

    case "task.error":
      return { ...state, mode: "error", headline: "Error", detail: e.message, pending: undefined };
  }
}
