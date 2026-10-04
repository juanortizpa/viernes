import { AnimatePresence, motion } from "framer-motion";
import type { IslandState } from "../state/island";
import { Raven } from "../raven/Raven";

const RISK_LABEL = { read: "Lectura", reversible: "Reversible", sensitive: "Sensible", critical: "Crítico" } as const;

interface Props {
  state: IslandState;
  onPermission: (granted: boolean) => void;
}

export function Island({ state, onPermission }: Props) {
  const expanded = state.mode !== "idle";
  const showEconomy = state.tokens > 0 || state.route === "local";

  return (
    <motion.div
      layout
      className={`island island--${state.mode}`}
      data-mode={state.mode}
      initial={false}
      animate={{ width: expanded ? 380 : 176, borderRadius: expanded ? 28 : 22 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
    >
      <motion.div layout="position" className="island__head">
        <motion.div layout className="island__raven">
          <Raven mode={state.mode} size={expanded ? 52 : 34} />
        </motion.div>

        <div className="island__text">
          <motion.div layout="position" className="island__title">
            {expanded ? state.headline : "JARVIS"}
          </motion.div>
          <AnimatePresence initial={false}>
            {expanded && state.detail && (
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

        {expanded && state.pending && (
          <motion.div key="perm" className="island__perm" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="island__perm-meta">
              <code>{state.pending.tool}</code>
              <span className={`risk risk--${state.pending.risk}`}>{RISK_LABEL[state.pending.risk]}</span>
            </div>
            <div className="island__perm-actions">
              <button className="btn btn--ghost" onClick={() => onPermission(false)}>Denegar</button>
              <button className="btn btn--primary" onClick={() => onPermission(true)}>Permitir</button>
            </div>
          </motion.div>
        )}

        {expanded && (state.model || showEconomy) && (
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
