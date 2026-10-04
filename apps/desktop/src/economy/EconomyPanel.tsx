import type { EconomySummary } from "@jarvis/protocol";
import { economyView } from "./format";

/** "AI Economy": what was spent, what was avoided, and how fast, straight from the stored traces. */
export function EconomyPanel({ summary, compact = false }: { summary?: EconomySummary; compact?: boolean }) {
  if (!summary) return <div className="economy economy--empty">Economía no disponible: el sidecar no guarda trazas listables.</div>;
  const v = economyView(summary);
  return (
    <section className={`economy${compact ? " economy--compact" : ""}`} aria-label="AI Economy">
      <h3 className="economy__title">{v.headline}</h3>
      <p className="economy__note">{v.savingsNote}</p>
      <dl className="economy__rows">
        {(compact ? v.rows.slice(0, 4) : v.rows).map((r) => (
          <div key={r.label} className="economy__row">
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
