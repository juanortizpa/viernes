import type { EconomySummary } from "@jarvis/protocol";

export const usd = (n: number): string => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(2)}`);
export const pct = (n: number): string => `${Math.round(n * 100)}%`;
export const ms = (n: number | null): string => (n === null ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

export interface EconomyView {
  headline: string;
  /** Plain statement of what the savings figure means (or why there is none). */
  savingsNote: string;
  rows: { label: string; value: string }[];
}

/** Turns the aggregate into labelled rows. Never invents a saving: without a priced baseline it says so. */
export function economyView(s: EconomySummary): EconomyView {
  const noLlm = s.byKind.local + s.byKind.instant + s.byKind.cache;
  const priced = s.baselineCostUsd > 0;
  return {
    headline: s.tasks === 0 ? "Aún no hay tareas registradas" : `${s.tasks} tareas · ${pct(s.successRate)} con éxito`,
    savingsNote: priced
      ? `Frente a usar siempre el modelo premium en las mismas tareas: ${usd(s.savedUsd)} (${s.savedPct === null ? "—" : pct(s.savedPct)}).`
      : "Sin ahorro en dólares que mostrar: no hay modelos con precio configurado (los gratuitos cuestan $0). Las tareas sin LLM sí evitaron llamadas.",
    rows: [
      { label: "Gasto estimado", value: usd(s.costUsd) },
      { label: "Tokens", value: `${s.inputTokens.toLocaleString("es")} entrada · ${s.outputTokens.toLocaleString("es")} salida` },
      { label: "Sin LLM", value: `${noLlm} (${s.byKind.local} locales · ${s.byKind.instant} rápidas · ${s.byKind.cache} de caché)` },
      { label: "Con modelo", value: `${s.byKind.model}${s.escalatedTasks ? ` · ${s.escalatedTasks} escaladas` : ""}` },
      { label: "Latencia media", value: `modelo ${ms(s.avgLatencyMs.model)} · sin LLM ${ms(s.avgLatencyMs.noLlm)}` },
      ...s.models.map((m) => ({ label: m.model, value: `${m.tasks} usos · ${usd(m.costUsd)}` })),
    ],
  };
}
