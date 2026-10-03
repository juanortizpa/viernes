import { useEffect, useMemo, useReducer, useRef } from "react";
import { initialState, islandReducer } from "./state/island";
import { DemoPlayer } from "./demo/player";
import { scenarios } from "./demo/scenarios";
import { Island } from "./island/Island";
import { Raven } from "./raven/Raven";
import type { Mode } from "./state/island";

/** Inside the Tauri window the page is just the island on a transparent background. */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const GALLERY: Mode[] = ["idle", "listening", "thinking", "executing", "permission", "success", "error", "warning"];

export default function App() {
  const [state, dispatch] = useReducer(islandReducer, initialState);
  const player = useMemo(() => new DemoPlayer(), []);
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(
    () =>
      player.subscribe((event) => {
        clearTimeout(collapseTimer.current);
        dispatch({ kind: "event", event });
        const terminal = event.type === "task.finished" || event.type === "task.error";
        if (terminal) collapseTimer.current = setTimeout(() => dispatch({ kind: "reset" }), 4500);
      }),
    [player],
  );

  if (inTauri) {
    return (
      <div className="stage stage--tauri">
        <Island state={state} onPermission={(g) => player.resolvePermission(g)} />
      </div>
    );
  }

  return (
    <div className="stage">
      <div className="stage__island">
        <Island state={state} onPermission={(g) => player.resolvePermission(g)} />
      </div>

      <main className="panel">
        <p className="badge">DEMO · escenarios guionados que reproducen el protocolo real. No es ejecución real todavía (Fase 1).</p>
        <h1>JARVIS</h1>
        <p className="muted">Elige un escenario. La isla y el cuervo solo muestran lo que llega como evento.</p>

        <div className="scenarios">
          {scenarios.map((s) => (
            <button key={s.id} className="scenario" onClick={() => void player.play(s)}>
              <strong>{s.title}</strong>
              <span>“{s.prompt}”</span>
            </button>
          ))}
        </div>

        <h2>Estados del cuervo</h2>
        <div className="gallery">
          {GALLERY.map((m) => (
            <div key={m} className="gallery__item">
              <Raven mode={m} size={64} />
              <span>{m}</span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
