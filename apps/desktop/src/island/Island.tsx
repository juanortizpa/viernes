import { AnimatePresence, motion } from "framer-motion";
import type { IslandState } from "../state/island";
import type { EconomySummary } from "@jarvis/protocol";
import { EconomyPanel } from "../economy/EconomyPanel";
import { Raven } from "../raven/Raven";

const RISK_LABEL = { read: "Lectura", reversible: "Reversible", sensitive: "Sensible", critical: "Crítico" } as const;

interface Props {
  state: IslandState;
  onPermission: (granted: boolean) => void;
  /** Present only when a real sidecar task can be cancelled (never for scripted demos). */
  onCancel?: () => void;
  economy?: EconomySummary;
  showEconomy?: boolean;
  /** Click on the idle island toggles the economy panel. Omit to disable. */
  onToggleEconomy?: () => void;
  /** Shown while the synthesiser is really speaking. */
  onStopSpeaking?: () => void;
}

const RUNNING = new Set(["thinking", "executing"]);

export function Island({ state, onPermission, onCancel, economy, showEconomy = false, onToggleEconomy, onStopSpeaking }: Props) {
  const economyOpen = showEconomy && state.mode === "idle";
  const expanded = state.mode !== "idle" || economyOpen || state.speaking === true;
  const showTokenChips = state.tokens > 0 || state.route === "local";

  return (
    <motion.div
      layout
      className={`island island--${state.mode}`}
      data-mode={state.mode}
      data-economy={economyOpen ? "open" : "closed"}
      onClick={state.mode === "idle" ? onToggleEconomy : undefined}
      role={state.mode === "idle" && onToggleEconomy ? "button" : undefined}
      aria-expanded={state.mode === "idle" && onToggleEconomy ? economyOpen : undefined}
      tabIndex={state.mode === "idle" && onToggleEconomy ? 0 : undefined}
      onKeyDown={(e) => state.mode === "idle" && onToggleEconomy && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggleEconomy())}
      initial={false}
      animate={{ width: expanded ? 380 : 176, borderRadius: expanded ? 28 : 22 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
    >
      <motion.div layout="position" className="island__head">
        <motion.div layout className="island__raven">
          <Raven mode={state.mode} size={expanded ? 52 : 34} level={state.level} speaking={state.speaking} />
        </motion.div>

        <div className="island__text">
          <motion.div layout="position" className="island__title">
            {economyOpen ? "AI Economy" : expanded ? state.headline : "JARVIS"}
          </motion.div>
          <AnimatePresence initial={false}>
            {expanded && !economyOpen && state.detail && (
              <motion.div
                key="detail"
                className="island__detail"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
              >
                {state.detail}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      <AnimatePresence initial={false}>
        {expanded && state.fraction !== undefined && (
          <motion.div key="bar" className="island__bar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="island__bar-fill" animate={{ width: `${Math.round(state.fraction * 100)}%` }} />
            <span>{Math.round(state.fraction * 100)}%</span>
          </motion.div>
        )}

        {economyOpen && (
          <motion.div key="economy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <EconomyPanel summary={economy} compact />
          </motion.div>
        )}

        {state.speaking && onStopSpeaking && (
          <motion.div key="speaking" className="island__chips" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <span className="chip">🔊 hablando</span>
            <button className="btn btn--ghost" onClick={(e) => (e.stopPropagation(), onStopSpeaking())}>Callar <kbd>Esc</kbd></button>
          </motion.div>
        )}

        {expanded && onCancel && RUNNING.has(state.mode) && !state.pending && (
          <motion.div key="cancel" className="island__perm-actions" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button className="btn btn--ghost" onClick={onCancel}>Cancelar</button>
          </motion.div>
        )}

        {expanded && state.pending && (
          <motion.div key="perm" className="island__perm" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="island__perm-meta">
              <code>{state.pending.tool}</code>
              <span className={`risk risk--${state.pending.risk}`}>{RISK_LABEL[state.pending.risk]}</span>
            </div>
            <div className="island__perm-actions">
              {/* Deny is the default focus: an accidental Enter or Space refuses rather than permits. Esc also denies. */}
              <button className="btn btn--ghost" autoFocus onClick={() => onPermission(false)}>Denegar <kbd>Esc</kbd></button>
              <button className="btn btn--primary" onClick={() => onPermission(true)}>Permitir</button>
            </div>
          </motion.div>
        )}

        {expanded && (state.model || showTokenChips) && (
          <motion.div key="chips" className="island__chips" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {state.route === "local" && <span className="chip chip--good">0 tokens · sin LLM</span>}
            {state.model && <span className="chip">{state.model}</span>}
            {state.tokens > 0 && <span className="chip">{state.tokens.toLocaleString("es")} tok · ${state.costUsd.toFixed(4)}</span>}
            {state.escalations > 0 && <span className="chip chip--warn">{state.escalations} escalado</span>}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
