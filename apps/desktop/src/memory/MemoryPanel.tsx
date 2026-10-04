import { useState } from "react";
import type { MemorySnapshot } from "../live/client";
import { memoryView } from "./format";

interface Props {
  memory?: MemorySnapshot;
  onForget: (id: string) => void;
  onClear: () => void;
  onToggle: (enabled: boolean) => void;
}

/**
 * What JARVIS remembers about you, and the controls over it (ADR-0023). Items are saved only by saying "recuerda que…";
 * here you can see each one, how often it was used, and erase it. Wiping everything takes a second click.
 */
export function MemoryPanel({ memory, onForget, onClear, onToggle }: Props) {
  const [confirmClear, setConfirmClear] = useState(false);
  if (!memory) return <p className="muted small">Memoria no disponible: el sidecar no la reportó.</p>;
  const v = memoryView(memory);
  return (
    <section className="memory" aria-label="Memoria">
      <p className="memory__summary">{v.summary}</p>
      <label className="memory__switch">
        <input type="checkbox" checked={memory.enabled} onChange={(e) => onToggle(e.target.checked)} /> Guardar y usar recuerdos
      </label>
      {v.items.length === 0 ? (
        <p className="muted small">Dile «recuerda que mi hermana se llama Ana» (por voz o escribiendo) y aparecerá aquí.</p>
      ) : (
        <ul className="memory__list">
          {v.items.map((i) => (
            <li key={i.id} className="memory__item">
              <span className="memory__text">
                <span className={`memory__kind memory__kind--${i.kind}`}>{i.kindLabel}</span> {i.text}
                <span className="muted small"> · {i.usage}</span>
              </span>
              <button type="button" className="dock__btn" onClick={() => onForget(i.id)} aria-label={`Olvidar: ${i.text}`} title="Olvidar">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {v.items.length > 0 &&
        (confirmClear ? (
          <p className="memory__confirm">
            ¿Borrar los {v.items.length} recuerdos?{" "}
            <button type="button" className="dock__btn" onClick={() => (onClear(), setConfirmClear(false))}>
              Sí, borrar todo
            </button>{" "}
            <button type="button" className="dock__btn" onClick={() => setConfirmClear(false)}>
              No
            </button>
          </p>
        ) : (
          <button type="button" className="dock__btn" onClick={() => setConfirmClear(true)}>
            Borrar toda la memoria
          </button>
        ))}
      <p className="muted small">{v.privacy}</p>
    </section>
  );
}
