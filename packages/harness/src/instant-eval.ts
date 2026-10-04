import { HashedNgramEmbedder, SemanticCache, isCacheable } from "@jarvis/core";
import { instantGroups, type InstantGroup } from "./suites/instant-pairs";

export interface InstantEvalRow {
  threshold: number;
  /** Rewordings served from the right entry / total rewordings. */
  hitRate: number;
  /** Look-alikes (and other groups' questions) served from a wrong entry / total. Must be 0. */
  falsePositives: number;
  /** Total look-alike probes. */
  probes: number;
  /** Probes skipped because the exclusion list blocks them before any matching. */
  excluded: number;
}

/** Learn each canonical question once (minSeen=1), then probe rewordings, look-alikes and every other group's questions. */
export function evalInstantCache(thresholds: number[], groups: InstantGroup[] = instantGroups): InstantEvalRow[] {
  return thresholds.map((threshold) => {
    const cache = new SemanticCache({ threshold, minSeen: 1, embedder: new HashedNgramEmbedder() });
    for (const g of groups) cache.learn(g.canonical, `ANSWER:${g.canonical}`);
    let hits = 0;
    let sameTotal = 0;
    let fp = 0;
    let probes = 0;
    let excluded = 0;
    for (const g of groups) {
      for (const q of g.same) {
        sameTotal++;
        if (!isCacheable(q).ok) excluded++;
        else if (cache.lookup(q)?.entry.response === `ANSWER:${g.canonical}`) hits++;
      }
      const wrong = [...g.different, ...groups.filter((o) => o !== g).flatMap((o) => [o.canonical, ...o.same])];
      for (const q of wrong) {
        probes++;
        const hit = cache.lookup(q);
        if (hit && hit.entry.response === `ANSWER:${g.canonical}`) fp++;
      }
    }
    return { threshold, hitRate: hits / sameTotal, falsePositives: fp, probes, excluded };
  });
}

export function renderInstantEval(rows: InstantEvalRow[]): string {
  const lines = ["| Umbral coseno | Aciertos (paráfrasis) | Falsos positivos | Sondas | Bloqueadas por exclusión |", "|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.threshold.toFixed(2)} | ${(r.hitRate * 100).toFixed(1)}% | ${r.falsePositives} | ${r.probes} | ${r.excluded} |`);
  return lines.join("\n");
}
