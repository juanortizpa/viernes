import type { RouteRequest } from "./model-router";
import { detectSensitive } from "./sensitivity";
import { classifyTask } from "./task-classifier";

/** The one place a prompt becomes a routing request, shared by the orchestrator and the offline replay so they cannot drift apart. */
export function routeRequestFor(input: string): RouteRequest {
  return { input, ...classifyTask(input), inputTokens: Math.ceil(input.length / 4), sensitive: detectSensitive(input).sensitive };
}
