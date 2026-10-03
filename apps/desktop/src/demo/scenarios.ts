import type { OrchestratorEvent, RoutingDecision, Usage } from "@jarvis/protocol";

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** An event minus the envelope fields the player fills in. Distributive to keep the union. */
export type EventBody = DistributiveOmit<OrchestratorEvent, "id" | "taskId" | "seq" | "ts">;

/** `when` makes a step run only after the user's permission answer. */
export interface Step {
  delay: number;
  event: EventBody;
  when?: "granted" | "denied";
}

export interface Scenario {
  id: string;
  title: string;
  prompt: string;
  steps: Step[];
}

const decision = (d: Partial<RoutingDecision> & Pick<RoutingDecision, "taskType" | "rationale">): RoutingDecision => ({
  kind: "model",
  strategy: "rules_v1",
  complexity: 0.3,
  candidates: [],
  propensity: 1,
  explored: false,
  ...d,
});

const usage = (inputTokens: number, outputTokens: number, estimatedCostUsd: number, latencyMs: number): Usage => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: 0,
  estimatedCostUsd,
  latencyMs,
});

const CHEAP = "claude-haiku-4-5-20251001";
const STRONG = "claude-sonnet-5-5";

// NOTE: these are scripted replays used only by the demo player. Numbers are illustrative.
export const scenarios: Scenario[] = [
  {
    id: "local",
    title: "Acción local",
    prompt: "Abre VS Code",
    steps: [
      { delay: 0, event: { type: "task.started", input: "Abre VS Code", modality: "text" } },
      { delay: 350, event: { type: "intent.resolved", route: "local", intent: "open_application · Visual Studio Code", confidence: 0.98 } },
      { delay: 450, event: { type: "tool.requested", tool: "open_application", risk: "reversible", summary: "Visual Studio Code" } },
      { delay: 700, event: { type: "tool.completed", tool: "open_application", ok: true, summary: "Ventana de VS Code activa" } },
      { delay: 400, event: { type: "task.finished", outcome: "success", summary: "VS Code abierto · 0 tokens" } },
    ],
  },
  {
    id: "cheap",
    title: "Modelo barato",
    prompt: "Explica este error de Java: NullPointerException",
    steps: [
      { delay: 0, event: { type: "task.started", input: "Explica este error de Java: NullPointerException", modality: "text" } },
      { delay: 300, event: { type: "intent.resolved", route: "llm", confidence: 0.9 } },
      {
        delay: 400,
        event: {
          type: "route.decided",
          decision: decision({ model: CHEAP, provider: "anthropic", taskType: "explanation", rationale: "Explicación simple → modelo rápido" }),
        },
      },
      { delay: 600, event: { type: "response.delta", text: "Un NullPointerException ocurre cuando " } },
      { delay: 450, event: { type: "response.delta", text: "usas un objeto que vale null. " } },
      { delay: 450, event: { type: "response.delta", text: "Revisa la variable de la línea del stack trace." } },
      { delay: 300, event: { type: "model.completed", model: CHEAP, usage: usage(420, 180, 0.0011, 1650) } },
      {
        delay: 300,
        event: {
          type: "eval.completed",
          verdict: { evaluator: "heuristic", outcome: "success", confidence: 0.86, evidence: "Respuesta completa y concisa" },
        },
      },
      { delay: 400, event: { type: "task.finished", outcome: "success", summary: "Resuelto sin modelo premium" } },
    ],
  },
  {
    id: "escalate",
    title: "Escalado con permiso",
    prompt: "Arregla el bug del proyecto y corre los tests",
    steps: [
      { delay: 0, event: { type: "task.started", input: "Arregla el bug del proyecto y corre los tests", modality: "text" } },
      { delay: 300, event: { type: "intent.resolved", route: "llm", confidence: 0.84 } },
      {
        delay: 400,
        event: {
          type: "route.decided",
          decision: decision({ model: CHEAP, provider: "anthropic", taskType: "debugging", complexity: 0.55, rationale: "Primer intento con modelo rápido" }),
        },
      },
      { delay: 500, event: { type: "progress", stage: "Archivos relevantes encontrados", detail: "12 de 214", fraction: 0.2 } },
      { delay: 700, event: { type: "model.completed", model: CHEAP, usage: usage(3200, 900, 0.0072, 5200) } },
      {
        delay: 500,
        event: {
          type: "eval.completed",
          verdict: { evaluator: "tests", outcome: "failure", confidence: 0.99, evidence: "3 tests fallan" },
        },
      },
      { delay: 600, event: { type: "escalated", from: CHEAP, to: STRONG, reason: "Los tests no pasan con el primer modelo" } },
      {
        delay: 450,
        event: {
          type: "route.decided",
          decision: decision({ model: STRONG, provider: "anthropic", taskType: "debugging", complexity: 0.55, rationale: "Escalado tras fallo del evaluador" }),
        },
      },
      { delay: 700, event: { type: "progress", stage: "Analizando arquitectura", detail: "Causa probable localizada", fraction: 0.55 } },
      {
        delay: 700,
        event: { type: "permission.required", requestId: "req-1", tool: "write_file", risk: "sensitive", reason: "Quiero modificar 2 archivos del proyecto" },
      },
      // The player emits permission.resolved itself, then continues with the branch below.
      { delay: 400, when: "granted", event: { type: "tool.requested", tool: "write_file", risk: "sensitive", summary: "src/UserService.java" } },
      { delay: 700, when: "granted", event: { type: "tool.completed", tool: "write_file", ok: true, summary: "2 archivos modificados" } },
      { delay: 500, when: "granted", event: { type: "progress", stage: "Corriendo tests", fraction: 0.85 } },
      { delay: 700, when: "granted", event: { type: "model.completed", model: STRONG, usage: usage(6100, 1400, 0.0394, 9100) } },
      {
        delay: 500,
        when: "granted",
        event: { type: "eval.completed", verdict: { evaluator: "tests", outcome: "success", confidence: 0.99, evidence: "Tests: 24 de 24" } },
      },
      { delay: 400, when: "granted", event: { type: "task.finished", outcome: "success", summary: "Arreglado tras 1 escalado" } },
      { delay: 500, when: "denied", event: { type: "task.finished", outcome: "cancelled", summary: "No se modificó ningún archivo" } },
    ],
  },
];
