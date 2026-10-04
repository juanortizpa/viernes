import type { ModelCapabilities, RoutingDecision, TaskType } from "@jarvis/protocol";

export interface RouteRequest {
  input: string;
  taskType: TaskType;
  /** 0..1 estimate; Phase 2 replaces the constant with a real estimator. */
  complexity: number;
}

/** Routers depend only on ModelCapabilities, never on provider packages (ADR-0003). */
export interface ModelRouter {
  route(req: RouteRequest, candidates: ModelCapabilities[]): RoutingDecision;
}

/** Phase 1 placeholder: always the same model. Real strategies arrive in Phase 2. */
export class StaticRouter implements ModelRouter {
  constructor(private readonly model: string) {}

  route(req: RouteRequest, candidates: ModelCapabilities[]): RoutingDecision {
    const chosen = candidates.find((c) => c.model === this.model);
    if (!chosen) throw new Error(`model not available: ${this.model}`);
    return {
      kind: "model",
      model: chosen.model,
      provider: chosen.provider,
      strategy: "static_v0",
      taskType: req.taskType,
      complexity: req.complexity,
      candidates: candidates.map((c) => ({ model: c.model, score: c.model === chosen.model ? 1 : 0 })),
      propensity: 1,
      explored: false,
      rationale: `static routing to ${chosen.model}`,
    };
  }
}
