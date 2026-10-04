import { normalizeText, type Intent, type RoutineStep } from "@jarvis/core";

/** Resolves one step's text the way a typed command would be resolved, but WITHOUT routines (no recursion) and without a model. */
export type StepResolver = (text: string) => Intent;

const VERB = /^(?:activa|activar|activame|ejecuta|ejecutar|ejecutame|inicia|iniciar|corre|correr|corremos|pon|poner|ponme|arranca|arrancar|lanza|lanzar|haz|hace|empieza|empezar)\s+(?:la\s+|el\s+|mi\s+)?(?:rutina\s+)?/;

/**
 * Routines (ADR-0027): a name the user chose ("modo trabajo") that runs several of their own commands in order. Steps are plain
 * phrases ("abre vs code", "en el proyecto web, corré los tests") resolved by the deterministic router: a step that would need a
 * model is refused, so a routine always does exactly what was written, at no model cost.
 */
export function resolveRoutine(name: string, steps: readonly string[], resolve: StepResolver): { steps: RoutineStep[]; problems: string[] } {
  const out: RoutineStep[] = [];
  const problems: string[] = [];
  for (const label of steps) {
    const i = resolve(label);
    if (i.route !== "local") problems.push(`«${label}» no es una orden que entienda sin un modelo`);
    else if (i.confidence < 1) problems.push(`«${label}» no lo reconozco con seguridad`);
    else if (i.sequence) problems.push(`«${label}» es otra rutina`);
    else out.push({ label, tool: i.tool, args: i.args });
  }
  if (out.length === 0 && problems.length === 0) problems.push(`la rutina «${name}» no tiene pasos`);
  return { steps: out, problems };
}

/** Every configured routine checked once, so mistakes show up in the log at start-up and not when the user says the name. */
export function checkRoutines(routines: Record<string, readonly string[]>, resolve: StepResolver): string[] {
  return Object.entries(routines).flatMap(([name, steps]) => resolveRoutine(name, steps, resolve).problems.map((p) => `rutina «${name}»: ${p}`));
}

/** The intent rule: the routine's name alone, or "activá/ejecutá (la rutina) <nombre>". A routine with a broken step does not run half. */
export function routineRule(routines: Record<string, readonly string[]>, resolve: StepResolver): (normalized: string) => Intent | undefined {
  const byKey = new Map(Object.entries(routines).map(([name, steps]) => [normalizeText(name), { name, steps }]));
  return (normalized) => {
    const hit = byKey.get(normalized) ?? byKey.get(normalized.replace(VERB, ""));
    if (!hit) return undefined;
    const r = resolveRoutine(hit.name, hit.steps, resolve);
    if (r.problems.length > 0) {
      return { route: "local", intent: "routine.invalid", tool: "routine.invalid", args: { name: hit.name, problems: r.problems }, confidence: 1 };
    }
    return { route: "local", intent: "routine.run", tool: "routine.run", args: { name: hit.name }, confidence: 1, sequence: { name: hit.name, steps: r.steps } };
  };
}
