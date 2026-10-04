import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { initialState, islandReducer } from "./state/island";
import { DemoPlayer } from "./demo/player";
import { scenarios } from "./demo/scenarios";
import { Island } from "./island/Island";
import { LiveClient } from "./live/client";
import type { OrchestratorEvent } from "@jarvis/protocol";
import { Raven } from "./raven/Raven";
import type { Mode } from "./state/island";

/** Inside the Tauri window the page is just the island on a transparent background. */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const GALLERY: Mode[] = ["idle", "listening", "thinking", "executing", "permission", "success", "error", "warning"];

export default function App() {
  const [state, dispatch] = useReducer(islandReducer, initialState);
  const player = useMemo(() => new DemoPlayer(), []);
  const live = useMemo(() => new LiveClient(), []);
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  const source = useRef<"demo" | "live">("demo");
  const [sourceLabel, setSourceLabel] = useState<"demo" | "live">("demo");
  const [input, setInput] = useState("");
  useSyncExternalStore(
    (cb) => live.onStatus(cb),
    () => live.status,
  );

  useEffect(() => {
    const onEvent = (event: OrchestratorEvent) => {
      clearTimeout(collapseTimer.current);
      dispatch({ kind: "event", event });
      const terminal = event.type === "task.finished" || event.type === "task.error";
      if (terminal) collapseTimer.current = setTimeout(() => dispatch({ kind: "reset" }), 4500);
    };
    const offDemo = player.subscribe(onEvent);
    const offLive = live.onEvent(onEvent);
    if (!inTauri) void live.connect();
    return () => {
      offDemo();
      offLive();
      live.close();
    };
  }, [player, live]);

  const answerPermission = (granted: boolean) => {
    if (source.current === "live" && state.pending) live.answerPermission(state.pending.requestId, granted);
    else player.resolvePermission(granted);
  };
  const playScenario = (s: (typeof scenarios)[number]) => {
    source.current = "demo";
    setSourceLabel("demo");
    void player.play(s);
  };
  const submit = () => {
    const text = input.trim();
    if (!text || live.status !== "ready") return;
    source.current = "live";
    setSourceLabel("live");
    player.stop();
    live.submit(text);
    setInput("");
  };

  if (inTauri) {
    return (
      <div className="stage stage--tauri">
        <Island state={state} onPermission={answerPermission} />
      </div>
    );
  }

  return (
    <div className="stage">
      <div className="stage__island">
        <Island state={state} onPermission={answerPermission} />
      </div>

      <main className="panel">
        {sourceLabel === "demo" ? (
          <p className="badge">DEMO · escenario guionado que reproduce el protocolo. No es ejecución real.</p>
        ) : (
          <p className="badge badge--live">
            LIVE · sidecar real
            {live.info?.offline ? " · sin proveedor de IA configurado: las respuestas son del eco offline" : ` · ${live.info?.models.join(", ")}`}
          </p>
        )}
        <h1>JARVIS</h1>
        <p className="muted">La isla y el cuervo solo muestran lo que llega como evento.</p>

        <form
          className="command"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={live.status === "ready" ? "Escribe una orden: «qué hora es?», «abre vscode», «hola»…" : "Sidecar no disponible"}
            disabled={live.status !== "ready"}
          />
          <button disabled={live.status !== "ready" || !input.trim()}>Enviar</button>
        </form>
        <p className="muted small">
          Sidecar: {live.status === "ready" ? "conectado" : live.status === "connecting" ? "conectando…" : `no disponible${live.lastError ? ` (${live.lastError})` : ""} — solo escenarios demo`}
        </p>

        <h2>Escenarios guionados</h2>

        <div className="scenarios">
          {scenarios.map((s) => (
            <button key={s.id} className="scenario" onClick={() => playScenario(s)}>
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
