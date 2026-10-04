import { shouldEscalate } from "@jarvis/protocol";
import { ResponseHeuristicEvaluator, routeRequestFor } from "@jarvis/core";
import { mean, pairedBootstrap, type Interval } from "./stats";
import type { Policy, Replay, ReplayData } from "./replay";

export interface PolicyRow {
  policy: string;
  n: number;
  success: Interval;
  meanCostUsd: number;
  meanLatencyMs: number;
  escalationRate: number;
  /** 1 - cost/cost(baseline). Positive = cheaper than the baseline. */
  costSaving: Interval;
  /** success(policy) - success(baseline), paired on tasks. */
  successDelta: Interval;
  onFrontier: boolean;
}

export interface ModelRow {
  model: string;
  passRate: number;
  meanCostUsd: number;
  meanLatencyMs: number;
}

export interface Report {
  baseline: string;
  tasks: number;
  droppedTasks: string[];
  models: ModelRow[];
  policies: PolicyRow[];
  judge: { accepts: number; falseAccepts: number; wastedRejects: number; correctRejects: number };
}

/** Non-dominated policies: nobody is both at least as cheap and at least as successful, with one strictly better. */
function frontier(rows: { meanCostUsd: number; success: Interval }[]): boolean[] {
  return rows.map((r, i) => !rows.some((o, j) => j !== i && o.meanCostUsd <= r.meanCostUsd && o.success.estimate >= r.success.estimate && (o.meanCostUsd < r.meanCostUsd || o.success.estimate > r.success.estimate)));
}

export function analyze(policies: Policy[], d: ReplayData, baseline: string, droppedTasks: string[], seed = 1): Report {
  const results = new Map<string, Replay[]>(policies.map((p) => [p.name, d.tasks.map((t) => p.run(t, d))]));
  const base = results.get(baseline);
  if (!base) throw new Error(`baseline policy not found: ${baseline}`);
  const n = d.tasks.length;
  const passes = (rs: Replay[]) => rs.map((r) => (r.pass ? 1 : 0));
  const costs = (rs: Replay[]) => rs.map((r) => r.costUsd);
  const pick = (xs: number[], idx: number[]) => idx.map((i) => xs[i]!);

  const rows: PolicyRow[] = policies.map((p) => {
    const rs = results.get(p.name)!;
    const ps = passes(rs), cs = costs(rs), bp = passes(base), bc = costs(base);
    const baseCostMean = mean(bc);
    const saving = (idx: number[]) => (mean(pick(bc, idx)) === 0 ? 0 : 1 - mean(pick(cs, idx)) / mean(pick(bc, idx)));
    return {
      policy: p.name,
      n,
      success: pairedBootstrap(n, (idx) => mean(pick(ps, idx)), { seed }),
      meanCostUsd: mean(cs),
      meanLatencyMs: mean(rs.map((r) => r.latencyMs)),
      escalationRate: mean(rs.map((r) => (r.path.length > 1 ? 1 : 0))),
      costSaving: baseCostMean === 0 ? { estimate: 0, lo: 0, hi: 0 } : pairedBootstrap(n, saving, { seed }),
      successDelta: pairedBootstrap(n, (idx) => mean(pick(ps, idx)) - mean(pick(bp, idx)), { seed }),
      onFrontier: false,
    };
  });
  frontier(rows).forEach((f, i) => (rows[i]!.onFrontier = f));

  const models: ModelRow[] = d.caps.map((m) => {
    const cells = d.tasks.map((t) => d.cell(t.id, m.model));
    return { model: m.model, passRate: mean(cells.map((c) => (c.pass ? 1 : 0))), meanCostUsd: mean(cells.map((c) => d.cost(c))), meanLatencyMs: mean(cells.map((c) => c.latencyMs)) };
  });

  // Calibration of the shipped evaluator against ground truth, over every (task, model) cell.
  const h = new ResponseHeuristicEvaluator();
  const judge = { accepts: 0, falseAccepts: 0, wastedRejects: 0, correctRejects: 0 };
  for (const t of d.tasks) {
    const taskType = routeRequestFor(t.prompt).taskType;
    for (const m of d.caps) {
      const c = d.cell(t.id, m.model);
      const accepts = !shouldEscalate(h.evaluate({ input: t.prompt, taskType, response: c.response }));
      if (accepts && c.pass) judge.accepts++;
      else if (accepts) judge.falseAccepts++;
      else if (c.pass) judge.wastedRejects++;
      else judge.correctRejects++;
    }
  }
  return { baseline, tasks: n, droppedTasks, models, policies: rows, judge };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (i: Interval, f: (x: number) => string = pct) => `${f(i.estimate)} [${f(i.lo)}, ${f(i.hi)}]`;
const usd = (x: number) => `$${x.toFixed(6)}`;

export function renderMarkdown(r: Report, prices: Record<string, { input: number; output: number }>): string {
  const lines = [
    `# Informe del arnés (${r.tasks} tareas completas${r.droppedTasks.length ? `, ${r.droppedTasks.length} descartadas por celdas faltantes` : ""})`,
    "",
    ...(r.droppedTasks.length
      ? ["> **Datos parciales:** las tareas descartadas pueden no ser una muestra aleatoria (p. ej. si la cuota diaria cortó la corrida). Con éxito 0 % o 100 % el bootstrap da un intervalo de ancho cero que no significa certeza.", ""]
      : []),
    `Línea base: \`${r.baseline}\`. Intervalos: bootstrap pareado sobre tareas, 95%. Los costos usan los precios supuestos de abajo, no costos medidos.`,
    "",
    "## Modelos (una pasada por tarea)",
    "| Modelo | Éxito | Costo medio | Latencia media |",
    "|---|---|---|---|",
    ...r.models.map((m) => `| ${m.model} | ${pct(m.passRate)} | ${usd(m.meanCostUsd)} | ${m.meanLatencyMs.toFixed(0)} ms |`),
    "",
    "## Políticas",
    "| Política | Éxito | Δ éxito vs base | Costo medio | Ahorro vs base | Escalado | Frontera |",
    "|---|---|---|---|---|---|---|",
    ...r.policies.map((p) => `| ${p.policy} | ${ci(p.success)} | ${ci(p.successDelta)} | ${usd(p.meanCostUsd)} | ${ci(p.costSaving)} | ${pct(p.escalationRate)} | ${p.onFrontier ? "sí" : ""} |`),
    "",
    "## Evaluador heurístico vs ground truth (todas las celdas)",
    `Acepta y era correcta: ${r.judge.accepts} · acepta pero era incorrecta (falso positivo): ${r.judge.falseAccepts} · rechaza y era correcta (escalado inútil): ${r.judge.wastedRejects} · rechaza y era incorrecta: ${r.judge.correctRejects}`,
    "",
    "## Precios supuestos (USD por 1M tokens)",
    ...Object.entries(prices).map(([m, p]) => `- ${m}: entrada ${p.input}, salida ${p.output}`),
    "",
  ];
  return lines.join("\n");
}
