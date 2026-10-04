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
  | { kind: "voice.recording" }
  | { kind: "voice.level"; level: number }
  | { kind: "voice.transcribing" }
  | { kind: "voice.heard"; text: string }
  | { kind: "voice.rejected"; message: string };

/**
 * Pure reducer: OrchestratorEvent -> island state. This is the ONLY way the UI learns what
 * JARVIS is doing (ADR-0004), so nothing here can show progress that did not happen.
 */
export function islandReducer(state: IslandState, action: IslandAction): IslandState {
  switch (action.kind) {
    case "reset":
      return initialState;
    case "voice.recording":
      return { ...initialState, mode: "listening", headline: "Escuchando…", detail: "Suelta para enviar", level: 0 };
    case "voice.level":
      return state.mode === "listening" ? { ...state, level: action.level } : state;
    case "voice.transcribing":
      return { ...state, mode: "thinking", headline: "Transcribiendo…", detail: undefined, level: undefined };
    case "voice.heard":
      return { ...state, mode: "thinking", headline: "Escuché", detail: action.text, level: undefined };
    case "voice.rejected":
      return { ...initialState, mode: "warning", headline: action.message };
  }
  const e = action.event;

  switch (e.type) {
    case "task.started":
      return { ...initialState, mode: "thinking", headline: "Pensando…", detail: e.input };

    case "intent.resolved":
      return e.route === "local"
        ? { ...state, route: "local", mode: "executing", headline: "Acción local", detail: e.intent }
        : { ...state, route: "llm", mode: "thinking", headline: "Eligiendo modelo…" };

    case "instant.issued":
      // Receipt or pleasantry from the deterministic instant layer; the UI says so rather than pretending a model spoke.
      return e.kind === "ack"
        ? { ...state, mode: "thinking", headline: "Recibido", detail: e.text }
        : { ...state, route: "local", mode: "thinking", headline: e.kind === "cache" ? "Respuesta guardada" : "Respuesta rápida", detail: e.text };

    case "route.decided":
      return {
        ...state,
        mode: "thinking",
        model: e.decision.model,
        headline: e.decision.model ? `Usando ${e.decision.model}` : state.headline,
        detail: e.decision.rationale,
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
      };

    case "task.finished":
      if (e.outcome === "success") return { ...state, mode: "success", headline: "Listo", detail: e.summary, fraction: undefined, pending: undefined };
      if (e.outcome === "failure") return { ...state, mode: "error", headline: "No pude completarlo", detail: e.summary, pending: undefined };
      return { ...state, mode: "idle", headline: "Cancelado", detail: e.summary, pending: undefined };

    case "task.error":
      return { ...state, mode: "error", headline: "Error", detail: e.message, pending: undefined };
  }
}
