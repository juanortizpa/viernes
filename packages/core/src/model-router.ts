import type { ModelCapabilities, RoutingDecision, TaskType, Usage } from "@jarvis/protocol";

export interface RouteRequest {
  input: string;
  taskType: TaskType;
  /** 0..1 estimate from `classifyTask`. */
  complexity: number;
  /** Estimated prompt size; candidates whose context window cannot hold it are rejected. */
  inputTokens?: number;
  needsTools?: boolean;
  needsVision?: boolean;
  /** Data must not leave the machine: only local models qualify. */
  sensitive?: boolean;
}

/** Routers depend only on ModelCapabilities, never on provider packages (ADR-0003). */
export interface ModelRouter {
  route(req: RouteRequest, candidates: ModelCapabilities[]): RoutingDecision;
}

export interface Rejection {
  model: string;
  reason: string;
}

/** Hard constraints first (ADR-0011): a strategy only ever chooses among models that can do the job. */
export function filterCandidates(
  req: RouteRequest,
  candidates: ModelCapabilities[],
): { eligible: ModelCapabilities[]; rejected: Rejection[] } {
  const eligible: ModelCapabilities[] = [];
  const rejected: Rejection[] = [];
  for (const c of candidates) {
    const reason = req.needsTools && !c.supportsTools
      ? "no tool support"
      : req.needsVision && !c.supportsVision
        ? "no vision support"
        : req.sensitive && !c.isLocal
          ? "data is sensitive and the model is not local"
          : req.inputTokens !== undefined && req.inputTokens > c.contextWindow
            ? "input exceeds context window"
            : undefined;
    if (reason) rejected.push({ model: c.model, reason });
    else eligible.push(c);
  }
  return { eligible, rejected };
}

/** Input + output price per 1M tokens: a crude but monotone "how premium is it" measure. */
export const blendedCost = (c: ModelCapabilities): number => c.estimatedInputCost + c.estimatedOutputCost;

/** Eligible models from weakest to strongest (by price; ties keep configuration order). Cascade escalation walks this ladder. */
export function escalationLadder(req: RouteRequest, candidates: ModelCapabilities[]): ModelCapabilities[] {
  return filterCandidates(req, candidates)
    .eligible.map((c, i) => ({ c, i }))
    .sort((a, b) => blendedCost(a.c) - blendedCost(b.c) || a.i - b.i)
    .map((x) => x.c);
}

/** Ties go to the LAST model, ties in `cheapestModel` to the FIRST: with equal (e.g. all-free) prices, configuration order means weakest -> strongest. */
export const premiumModel = (cs: ModelCapabilities[]): ModelCapabilities | undefined =>
  cs.reduce<ModelCapabilities | undefined>((best, c) => (!best || blendedCost(c) >= blendedCost(best) ? c : best), undefined);

export const cheapestModel = (cs: ModelCapabilities[]): ModelCapabilities | undefined =>
  cs.reduce<ModelCapabilities | undefined>((best, c) => (!best || blendedCost(c) < blendedCost(best) ? c : best), undefined);

/** Cost of `usage` if it had run on `caps`, from the user's price estimates. */
export const estimateCostUsd = (caps: ModelCapabilities, usage: Pick<Usage, "inputTokens" | "outputTokens">): number =>
  (usage.inputTokens * caps.estimatedInputCost + usage.outputTokens * caps.estimatedOutputCost) / 1_000_000;

function decide(
  strategy: string,
  req: RouteRequest,
  chosen: ModelCapabilities,
  eligible: ModelCapabilities[],
  rejected: Rejection[],
  rationale: string,
): RoutingDecision {
  return {
    kind: "model",
    model: chosen.model,
    provider: chosen.provider,
    strategy,
    taskType: req.taskType,
    complexity: req.complexity,
    candidates: [
      ...eligible.map((c) => ({ model: c.model, score: c.model === chosen.model ? 1 : 0 })),
      ...rejected.map((r) => ({ model: r.model, score: 0, reason: r.reason })),
    ],
    propensity: 1, // deterministic strategies: the chosen action has probability 1 (ADR-0006)
    explored: false,
    rationale,
  };
}

function pick(
  strategy: string,
  req: RouteRequest,
  candidates: ModelCapabilities[],
  choose: (eligible: ModelCapabilities[]) => { model: ModelCapabilities | undefined; why: string },
): RoutingDecision {
  const { eligible, rejected } = filterCandidates(req, candidates);
  const { model, why } = choose(eligible);
  if (!model) {
    const detail = rejected.map((r) => `${r.model}: ${r.reason}`).join("; ") || "no models configured";
    throw new Error(`no eligible model (${detail})`);
  }
  return decide(strategy, req, model, eligible, rejected, why);
}

/** Phase 1 placeholder kept for fixed-model setups: always the same model. */
export class StaticRouter implements ModelRouter {
  constructor(private readonly model: string) {}

  route(req: RouteRequest, candidates: ModelCapabilities[]): RoutingDecision {
    const chosen = candidates.find((c) => c.model === this.model);
    if (!chosen) throw new Error(`model not available: ${this.model}`);
    return decide("static_v0", req, chosen, candidates, [], `static routing to ${chosen.model}`);
  }
}

export class AlwaysPremiumRouter implements ModelRouter {
  route(req: RouteRequest, candidates: ModelCapabilities[]): RoutingDecision {
    return pick("always_premium", req, candidates, (e) => {
      const m = premiumModel(e);
      return { model: m, why: `most expensive eligible model: ${m?.model}` };
    });
  }
}

export class AlwaysCheapestRouter implements ModelRouter {
  route(req: RouteRequest, candidates: ModelCapabilities[]): RoutingDecision {
    return pick("always_cheapest", req, candidates, (e) => {
      const m = cheapestModel(e);
      return { model: m, why: `cheapest eligible model: ${m?.model}` };
    });
  }
}

const HARD_TYPES: ReadonlySet<TaskType> = new Set(["coding", "debugging", "agentic_project"]);

/** Cheap model for easy work, premium for hard work (by task type or complexity). */
export class RulesRouter implements ModelRouter {
  constructor(private readonly threshold = 0.6) {}

  route(req: RouteRequest, candidates: ModelCapabilities[]): RoutingDecision {
    return pick("rules_v1", req, candidates, (e) => {
      const hard = HARD_TYPES.has(req.taskType) || req.complexity >= this.threshold;
      const m = hard ? premiumModel(e) : cheapestModel(e);
      return { model: m, why: `${hard ? "hard" : "easy"} task (${req.taskType}, complexity ${req.complexity}) -> ${m?.model}` };
    });
  }
}
