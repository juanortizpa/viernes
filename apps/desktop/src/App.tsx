import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { initialState, islandReducer } from "./state/island";
import { DemoPlayer } from "./demo/player";
import { scenarios } from "./demo/scenarios";
import { Island } from "./island/Island";
import { LiveClient } from "./live/client";
import { MicUnavailable, startMic, type MicSession } from "./voice/mic";
import { toBase64 } from "./voice/pcm-buffer";
import type { EconomySummary, OrchestratorEvent } from "@jarvis/protocol";
import { EconomyPanel } from "./economy/EconomyPanel";
import { Raven } from "./raven/Raven";
import type { Mode } from "./state/island";

/** Inside the Tauri window the page is just the island on a transparent background. */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const GALLERY: Mode[] = ["idle", "listening", "thinking", "executing", "permission", "success", "error", "warning"];

export default function App() {
  const [state, dispatch] = useReducer(islandReducer, initialState);
  const [economy, setEconomy] = useState<EconomySummary>();
  const [showEconomy, setShowEconomy] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const player = useMemo(() => new DemoPlayer(), []);
  const live = useMemo(() => new LiveClient(), []);
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  const source = useRef<"demo" | "live">("demo");
  const [sourceLabel, setSourceLabel] = useState<"demo" | "live">("demo");
  const [input, setInput] = useState("");
  const mic = useRef<{ session?: MicSession; wantStop: boolean; busy: boolean }>({ wantStop: false, busy: false });
  useSyncExternalStore(
    (cb) => live.onStatus(cb),
    () => live.status,
  );

  useEffect(() => {
    const onEvent = (event: OrchestratorEvent) => {
      clearTimeout(collapseTimer.current);
      dispatch({ kind: "event", event });
      const terminal = event.type === "task.finished" || event.type === "task.error";
      if (event.type === "task.finished" && live.status === "ready") live.requestEconomy();
      if (terminal) collapseTimer.current = setTimeout(() => dispatch({ kind: "reset" }), 4500);
    };
    const offDemo = player.subscribe(onEvent);
    const offLive = live.onEvent(onEvent);
    const offEconomy = live.onEconomy(setEconomy);
    const offVoice = live.onVoice((n) => {
      clearTimeout(collapseTimer.current);
      if (n.kind === "transcribed") dispatch({ kind: "voice.heard", text: n.text });
      else {
        dispatch({ kind: "voice.rejected", message: n.message });
        collapseTimer.current = setTimeout(() => dispatch({ kind: "reset" }), 4500);
      }
    });
    if (!inTauri) void live.connect();
    return () => {
      offDemo();
      offLive();
      offVoice();
      offEconomy();
      live.close();
    };
  }, [player, live]);

  const toggleEconomy = () => {
    setShowEconomy((open) => {
      if (!open && live.status === "ready") live.requestEconomy();
      return !open;
    });
  };
  const cancel = () => live.cancel();

  const warn = (message: string) => {
    clearTimeout(collapseTimer.current);
    dispatch({ kind: "voice.rejected", message });
    collapseTimer.current = setTimeout(() => dispatch({ kind: "reset" }), 4500);
  };

  /** Push-to-talk: the microphone is open only while this is held. */
  const startTalk = async () => {
    const m = mic.current;
    if (m.busy) return;
    if (live.status !== "ready" || !live.info?.voice) return warn("Voz no configurada en el sidecar");
    m.busy = true;
    m.wantStop = false;
    clearTimeout(collapseTimer.current);
    player.stop();
    source.current = "live"; // a real microphone and a real sidecar: never label this as a demo
    setSourceLabel("live");
    dispatch({ kind: "voice.recording" });
    try {
      m.session = await startMic((level) => dispatch({ kind: "voice.level", level }), () => void stopTalk());
    } catch (e) {
      m.busy = false;
      return warn(e instanceof MicUnavailable ? e.message : "No se pudo abrir el micrófono");
    }
    if (m.wantStop) void stopTalk(); // released while the mic was still opening
  };
  const stopTalk = async (discard = false) => {
    const m = mic.current;
    if (!m.busy) return;
    if (!m.session) {
      m.wantStop = true;
      return;
    }
    const session = m.session;
    m.session = undefined;
    m.busy = false;
    const buffer = await session.stop();
    if (discard) return dispatch({ kind: "reset" });
    const wav = buffer.toWav();
    if (!wav) return warn("Muy corto: mantén pulsado mientras hablas");
    source.current = "live";
    setSourceLabel("live");
    dispatch({ kind: "voice.transcribing" });
    live.submitVoice(toBase64(wav));
  };

  useEffect(() => {
    const isTalkKey = (e: KeyboardEvent) => e.ctrlKey && e.code === "Space";
    const down = (e: KeyboardEvent) => {
      if (isTalkKey(e) && !e.repeat) (e.preventDefault(), void startTalk());
      else if (e.key === "Escape") {
        if (mic.current.busy) void stopTalk(true);
        else if (stateRef.current.pending) answerPermission(false);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === "Control") void stopTalk();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

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
        <Island state={state} onPermission={answerPermission} economy={economy} showEconomy={showEconomy} onToggleEconomy={toggleEconomy} />
      </div>
    );
  }

  return (
    <div className="stage">
      <div className="stage__island">
        <Island
          state={state}
          onPermission={answerPermission}
          onCancel={sourceLabel === "live" && live.status === "ready" ? cancel : undefined}
          economy={economy}
          showEconomy={showEconomy}
          onToggleEconomy={live.status === "ready" ? toggleEconomy : undefined}
        />
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
          <button
            type="button"
            className={`mic${state.mode === "listening" ? " mic--on" : ""}`}
            disabled={live.status !== "ready" || !live.info?.voice}
            title={live.info?.voice ? "Mantén pulsado para hablar (o Ctrl+Espacio)" : "Voz no configurada: ver docs/adr/0016-voice-push-to-talk.md"}
            aria-label="Pulsar para hablar"
            onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), void startTalk())}
            onPointerUp={() => void stopTalk()}
            onPointerCancel={() => void stopTalk(true)}
          >
            🎙
          </button>
        </form>
        <p className="muted small">
          Sidecar: {live.status === "ready" ? "conectado" : live.status === "connecting" ? "conectando…" : `no disponible${live.lastError ? ` (${live.lastError})` : ""} — solo escenarios demo`}
        </p>

        <h2>AI Economy</h2>
        {live.status === "ready" ? (
          <>
            <EconomyPanel summary={economy} />
            <button className="scenario" onClick={() => live.requestEconomy()}>Actualizar</button>
          </>
        ) : (
          <p className="muted small">Disponible con el sidecar conectado.</p>
        )}

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
