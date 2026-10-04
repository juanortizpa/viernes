import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { initialState, islandReducer } from "./state/island";
import { DemoPlayer } from "./demo/player";
import { scenarios } from "./demo/scenarios";
import { Island } from "./island/Island";
import { LiveClient, type MemorySnapshot } from "./live/client";
import { MemoryPanel } from "./memory/MemoryPanel";
import { isTauri, tauriTransport } from "./live/tauri-transport";
import { IslandDock } from "./island/IslandDock";
import { fitWindowTo } from "./shell/window-fit";
import { reportHitRegions } from "./shell/hit-regions";
import { hideIsland, onGlobalPushToTalk, setHitRegions, shellInfo, type ShellInfo } from "./shell/shell";
import { IslandSettings } from "./island/IslandSettings";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { MicUnavailable, startMic, type MicSession } from "./voice/mic";
import { toBase64 } from "./voice/pcm-buffer";
import type { VoiceStream } from "./voice/voice-stream";
import { WakeSession } from "./voice/wake-session";
import { WakeSettings } from "./voice/WakeSettings";
import { BenchRecorder } from "./voice/BenchRecorder";
import { loadAudioDsp, saveAudioDsp, type AudioDsp } from "./voice/audio-settings";
import { SpeechController, type SynthLike } from "./speech/controller";
import { SPEAK_MODES, parseSpeakMode, type SpeakMode } from "./speech/policy";
import { TaskSpeaker } from "./speech/task-speaker";
import type { EconomySummary, OrchestratorEvent } from "@jarvis/protocol";
import { EconomyPanel } from "./economy/EconomyPanel";
import { Raven } from "./raven/Raven";
import type { Mode } from "./state/island";

/** Inside the Tauri window the page is just the island (and its dock) on a transparent background. */
const inTauri = isTauri();
const GALLERY: Mode[] = ["idle", "listening", "thinking", "executing", "permission", "success", "error", "warning"];

function storeWakeEnabled(on: boolean): void {
  try {
    localStorage.setItem("jarvis.wakeEnabled", on ? "1" : "0");
  } catch {
    /* session-only */
  }
}

export default function App() {
  const [state, dispatch] = useReducer(islandReducer, initialState);
  const [economy, setEconomy] = useState<EconomySummary>();
  const [showEconomy, setShowEconomy] = useState(false);
  const [memory, setMemory] = useState<MemorySnapshot>();
  const stateRef = useRef(state);
  stateRef.current = state;
  const player = useMemo(() => new DemoPlayer(), []);
  // Browser: the Vite dev bridge spawns the sidecar. Tauri: the shell spawns it and relays its stdio (ADR-0021).
  const live = useMemo(() => new LiveClient(inTauri ? tauriTransport() : {}), []);
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  const source = useRef<"demo" | "live">("demo");
  const [sourceLabel, setSourceLabel] = useState<"demo" | "live">("demo");
  const [input, setInput] = useState("");
  const mic = useRef<{ session?: MicSession; stream?: VoiceStream; wantStop: boolean; busy: boolean }>({ wantStop: false, busy: false });

  // Text-to-speech through the voices the OS/browser already has (nothing to download). Absent in some shells.
  const [speakMode, setSpeakMode] = useState<SpeakMode>(() => {
    try {
      return parseSpeakMode(localStorage.getItem("jarvis.speakMode"));
    } catch {
      return "voice";
    }
  });
  const speakModeRef = useRef(speakMode);
  speakModeRef.current = speakMode;
  const [speechNote, setSpeechNote] = useState<string>();
  const [ttfa, setTtfa] = useState<number>();
  const taskStartedAt = useRef<number>(0);
  /** When the user stopped talking (key released / end of utterance): the start of the latency the user feels (ADR-0029). */
  const speechEndedAt = useRef<number>(0);
  const [voiceLatency, setVoiceLatency] = useState<{ afterEndMs: number; speculated: boolean; firstAudioMs?: number }>();
  const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
  const speech = useMemo(
    () =>
      speechSupported
        ? new SpeechController(
            window.speechSynthesis as unknown as SynthLike,
            (t) => new SpeechSynthesisUtterance(t) as never,
            {
              onStart: () => {
                dispatch({ kind: "speech", speaking: true });
                wakeRef.current?.onSpeaking(true);
                if (taskStartedAt.current) (setTtfa(Math.round(performance.now() - taskStartedAt.current)), (taskStartedAt.current = 0));
                if (speechEndedAt.current) {
                  const firstAudioMs = Math.round(performance.now() - speechEndedAt.current);
                  speechEndedAt.current = 0;
                  setVoiceLatency((v) => ({ afterEndMs: v?.afterEndMs ?? 0, speculated: v?.speculated ?? false, firstAudioMs }));
                }
              },
              onIdle: () => {
                dispatch({ kind: "speech", speaking: false });
                wakeRef.current?.onSpeaking(false);
              },
              onNoVoice: (lang) => setSpeechNote(`No hay una voz instalada para ${lang === "es" ? "español" : "inglés"}: añádela en Configuración de Windows › Hora e idioma › Voz.`),
            },
          )
        : undefined,
    [speechSupported],
  );
  const taskSpeaker = useMemo(
    () => (speech ? new TaskSpeaker({ speak: (t, l) => speech.speak(t, l), cancel: () => speech.cancel() }, () => speakModeRef.current) : undefined),
    [speech],
  );
  const speakingRef = useRef(false);
  const wakeRef = useRef<WakeSession>();
  const taskModality = useRef<"text" | "voice">("text");
  const [wakeEnabled, setWakeEnabled] = useState(() => {
    try {
      return localStorage.getItem("jarvis.wakeEnabled") === "1";
    } catch {
      return false;
    }
  });
  const [wakeNote, setWakeNote] = useState<string>();
  const [audioDsp, setAudioDsp] = useState<AudioDsp>(loadAudioDsp);
  const [wakeReadout, setWakeReadout] = useState<string>();
  useEffect(() => {
    if (!wakeEnabled) return setWakeReadout(undefined);
    const id = setInterval(() => {
      const d = wakeRef.current?.diagnostics();
      if (!d) return;
      setWakeReadout(
        d.stage1 === "template"
          ? `Filtro rápido: puntaje ${d.bestScore === undefined ? "—" : d.bestScore.toFixed(2)} (dispara con ≤ ${d.threshold?.toFixed(2)}) · verificadas ${d.verified} · ignoradas ${d.notForMe}`
          : `Sin tu voz registrada: se verifica cada frase · verificadas ${d.verified}`,
      );
    }, 500);
    return () => clearInterval(id);
  }, [wakeEnabled]);
  speakingRef.current = state.speaking === true;
  const chooseSpeakMode = (m: SpeakMode) => {
    setSpeakMode(m);
    if (m === "never") speech?.cancel();
    try {
      localStorage.setItem("jarvis.speakMode", m);
    } catch {
      /* private mode: the choice just lasts for this session */
    }
  };
  useSyncExternalStore(
    (cb) => live.onStatus(cb),
    () => live.status,
  );

  /** Collapse the island after `ms`, but not while it is still talking. */
  const scheduleReset = (ms: number) => {
    collapseTimer.current = setTimeout(function tick() {
      if (speakingRef.current) collapseTimer.current = setTimeout(tick, 800);
      else dispatch({ kind: "reset" });
    }, ms);
  };

  useEffect(() => {
    const onEvent = (event: OrchestratorEvent) => {
      clearTimeout(collapseTimer.current);
      if (event.type === "task.started") {
        taskStartedAt.current = performance.now();
        taskModality.current = event.modality;
        wakeRef.current?.setPaused(false);
        wakeRef.current?.onTaskStarted();
      }
      if (event.type === "task.finished" || event.type === "task.error") wakeRef.current?.onTaskDone(taskModality.current === "voice");
      taskSpeaker?.onEvent(event);
      dispatch({ kind: "event", event });
      const terminal = event.type === "task.finished" || event.type === "task.error";
      if (event.type === "task.finished" && live.status === "ready") (live.requestEconomy(), live.requestMemory()); // "recuerda que…" and usage counters change it
      if (terminal) scheduleReset(4500);
    };
    const offDemo = player.subscribe(onEvent);
    const offLive = live.onEvent(onEvent);
    const offEconomy = live.onEconomy(setEconomy);
    const offMemory = live.onMemory(setMemory);
    const offStatus = live.onStatus(() => live.status === "ready" && live.requestMemory());
    const offVoice = live.onVoice((n) => {
      clearTimeout(collapseTimer.current);
      if (n.kind === "partial") return dispatch({ kind: "voice.partial", text: n.text });
      if (n.kind === "transcribed") {
        dispatch({ kind: "voice.heard", text: n.text, ...(n.engine ? { engine: n.engine } : {}), ...(n.heard ? { heard: n.heard } : {}) });
        if (n.afterEndMs !== undefined) setVoiceLatency({ afterEndMs: n.afterEndMs, speculated: n.speculated === true });
      } else {
        wakeRef.current?.setPaused(false);
        dispatch({ kind: "voice.rejected", message: n.message });
        scheduleReset(4500);
      }
    });
    void live.connect();
    return () => {
      offDemo();
      offLive();
      offVoice();
      offEconomy();
      offMemory();
      offStatus();
      live.close();
    };
  }, [player, live, taskSpeaker]);

  const startWake = async () => {
    if (!live.info?.voice) return;
    await wakeRef.current?.stop();
    const session = new WakeSession(live, {
      onState: (state, followUpMs) => dispatch({ kind: "wake", state, followUpMs }),
      onLevel: (level) => dispatch({ kind: "voice.level", level }),
      onError: (m) => (setWakeNote(m), setWakeEnabled(false), storeWakeEnabled(false)), // don't retry a broken microphone on every launch
      onCommandSent: (endSilenceMs) => void (speechEndedAt.current = performance.now() - endSilenceMs),
    });
    wakeRef.current = session;
    setWakeNote(undefined);
    await session.start();
  };
  const stopWake = async () => {
    await wakeRef.current?.stop();
    wakeRef.current = undefined;
    dispatch({ kind: "wake", state: "off" });
  };
  const chooseAudioDsp = (v: AudioDsp) => {
    setAudioDsp(v);
    saveAudioDsp(v);
    if (wakeEnabled) void startWake(); // the always-on microphone must be reopened with the new constraints
  };
  const chooseWake = (on: boolean) => {
    setWakeEnabled(on);
    storeWakeEnabled(on);
    if (on) setWakeNote(undefined);
    void (on ? startWake() : stopWake());
  };
  // Resume hands-free listening after a reload if it was left on, once the sidecar (which has the speech engine) is ready.
  const wakeBooted = useRef(false);
  useEffect(
    () =>
      live.onStatus(() => {
        if (live.status === "ready" && wakeEnabled && !wakeBooted.current && live.info?.voice) {
          wakeBooted.current = true;
          void startWake();
        }
      }),
    [live, wakeEnabled],
  );
  useEffect(() => () => void wakeRef.current?.stop(), []);

  // Tauri: the window follows the island's real size (nothing clipped), clicks outside the island and its dock go to the
  // apps underneath, and the shell's global push-to-talk drives the same microphone code as the button.
  const tauriStage = useRef<HTMLDivElement>(null);
  const [shell, setShell] = useState<ShellInfo>();
  const [showSettings, setShowSettings] = useState(false);
  const talkRef = useRef({ startTalk: async () => {}, stopTalk: async (_discard?: boolean) => {} });
  useEffect(() => {
    if (!inTauri || !tauriStage.current) return;
    const stage = tauriStage.current;
    const offFit = fitWindowTo(stage, 420, (w, h) => getCurrentWindow().setSize(new LogicalSize(w, h)));
    const offHits = reportHitRegions(stage, (rects, hold) => void setHitRegions(rects, hold).catch(() => undefined));
    const offPtt = onGlobalPushToTalk((s) => void (s === "pressed" ? talkRef.current.startTalk() : talkRef.current.stopTalk()));
    shellInfo().then(setShell, () => setShell({ pttShortcut: null, clickThrough: false }));
    return () => (offFit(), offHits(), offPtt());
  }, []);

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
    scheduleReset(4500);
  };

  /** Push-to-talk: the microphone is open only while this is held. */
  const startTalk = async () => {
    const m = mic.current;
    if (m.busy) return;
    if (live.status !== "ready" || !live.info?.voice) return warn("Voz no configurada en el sidecar");
    m.busy = true;
    m.wantStop = false;
    wakeRef.current?.setPaused(true); // push-to-talk owns the microphone while held
    speech?.cancel(); // talking over it interrupts it (and keeps the mic from hearing the speaker)
    clearTimeout(collapseTimer.current);
    player.stop();
    source.current = "live"; // a real microphone and a real sidecar: never label this as a demo
    setSourceLabel("live");
    dispatch({ kind: "voice.preparing" });
    // Streaming (ADR-0029): the sidecar hears the words as they are said and starts thinking before the key is released.
    const stream = live.info?.streaming ? live.openVoiceStream() : undefined;
    m.stream = stream;
    try {
      m.session = await startMic((level) => dispatch({ kind: "voice.level", level }), () => void stopTalk(), undefined, stream ? (c) => stream.push(c) : undefined);
    } catch (e) {
      m.busy = false;
      stream?.cancel();
      m.stream = undefined;
      return warn(e instanceof MicUnavailable ? e.message : "No se pudo abrir el micrófono");
    }
    if (m.wantStop) void stopTalk(); // released while the mic was still opening
    else dispatch({ kind: "voice.recording" }); // only now is the microphone really capturing
  };
  const stopTalk = async (discard = false) => {
    const m = mic.current;
    if (!m.busy) return;
    if (!m.session) {
      m.wantStop = true;
      return;
    }
    const session = m.session;
    const stream = m.stream;
    m.session = undefined;
    m.stream = undefined;
    m.busy = false;
    const buffer = await session.stop();
    if (discard) return (stream?.cancel(), wakeRef.current?.setPaused(false), dispatch({ kind: "reset" }));
    const wav = buffer.toWav();
    if (!wav) return (stream?.cancel(), wakeRef.current?.setPaused(false), warn("Muy corto: mantén pulsado mientras hablas"));
    source.current = "live";
    setSourceLabel("live");
    dispatch({ kind: "voice.transcribing" });
    speechEndedAt.current = performance.now();
    if (stream) stream.end();
    else live.submitVoice(toBase64(wav));
  };

  talkRef.current = { startTalk, stopTalk };

  useEffect(() => {
    const isTalkKey = (e: KeyboardEvent) => e.ctrlKey && e.code === "Space";
    const down = (e: KeyboardEvent) => {
      if (isTalkKey(e) && !e.repeat) (e.preventDefault(), void startTalk());
      else if (e.key === "Escape") {
        if (speakingRef.current) speech?.cancel();
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
      <div className="stage stage--tauri" ref={tauriStage}>
        <Island
          state={state}
          onPermission={answerPermission}
          onCancel={sourceLabel === "live" && live.status === "ready" ? cancel : undefined}
          economy={economy}
          showEconomy={showEconomy}
          onToggleEconomy={live.status === "ready" ? toggleEconomy : undefined}
          onStopSpeaking={speech ? () => speech.cancel() : undefined}
        />
        <IslandDock
          status={live.status}
          lastError={live.lastError}
          voice={live.info?.voice === true}
          talking={state.mode === "listening" && mic.current.busy}
          input={input}
          onInput={setInput}
          onSubmit={submit}
          onTalkStart={() => void startTalk()}
          onTalkStop={(discard) => void stopTalk(discard)}
          wakeEnabled={wakeEnabled}
          onToggleWake={chooseWake}
          onRetry={() => void live.connect()}
          settingsOpen={showSettings}
          onToggleSettings={() => setShowSettings((o) => !o)}
          pttShortcut={shell?.pttShortcut}
        />
        {wakeNote && !showSettings && (
          <p className="dock__note dock__note--float">
            {wakeNote}{" "}
            <button type="button" className="dock__dismiss" onClick={() => setWakeNote(undefined)} aria-label="Descartar aviso">
              ✕
            </button>
          </p>
        )}
        {showSettings && (
          <IslandSettings
            speakMode={speakMode}
            onSpeakMode={chooseSpeakMode}
            speech={speech !== undefined}
            audioDsp={audioDsp}
            onAudioDsp={chooseAudioDsp}
            pttShortcut={shell?.pttShortcut}
            memory={<MemoryPanel memory={memory} onForget={(id) => live.forgetMemory(id)} onClear={() => live.clearMemory()} onToggle={(on) => live.setMemoryEnabled(on)} />}
            wake={
              <WakeSettings
                enabled={wakeEnabled}
                unavailable={live.status !== "ready" ? "Disponible con el sidecar conectado." : !live.info?.voice ? "Falta configurar el reconocimiento de voz (ver setup.bat)." : wakeNote}
                state={state.wake?.state ?? "off"}
                readout={wakeReadout}
                onToggle={chooseWake}
                onEnrollmentChanged={() => wakeEnabled && void startWake()}
              />
            }
            onHide={() => void hideIsland().catch(() => undefined)}
            onClose={() => setShowSettings(false)}
          />
        )}
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
          onStopSpeaking={speech ? () => speech.cancel() : undefined}
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

        <div className="speak">
          <label>
            Hablar:{" "}
            <select value={speakMode} disabled={!speech} onChange={(e) => chooseSpeakMode(parseSpeakMode(e.target.value))}>
              {SPEAK_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small">
            {speech
              ? voiceLatency?.firstAudioMs !== undefined
                ? `primer audio: ${voiceLatency.firstAudioMs} ms tras dejar de hablar (texto a los ${voiceLatency.afterEndMs} ms${voiceLatency.speculated ? ", ya venía pensando" : ""})`
                : ttfa !== undefined
                  ? `primer audio: ${ttfa} ms tras enviar`
                  : ""
              : "este entorno no tiene síntesis de voz"}
            {speechNote ? ` · ${speechNote}` : ""}
          </span>
        </div>

        <div className="speak">
          <label>
            Audio del navegador:{" "}
            <select value={audioDsp} onChange={(e) => chooseAudioDsp(e.target.value === "off" ? "off" : "on")}>
              <option value="on">Procesado (cancela ruido y eco)</option>
              <option value="off">Crudo (sin procesar)</option>
            </select>
          </label>
          <span className="muted small">
            {live.info?.voiceEngines?.length ? `Transcripción: ${live.info.voiceEngines.map((e) => (e === "local" ? "whisper local (no sale del equipo)" : `${e.replaceAll("groq:", "Groq ").replaceAll("gemini:", "Gemini ").replace("+", " + ")} (nube: el audio sale del equipo)`)).join(" → respaldo: ")}. ` : ""}
            Si cambias esto, vuelve a registrar tu voz de «jarvis». Usa «Prueba de transcripción» para saber cuál va mejor.</span>
        </div>

        <WakeSettings
          enabled={wakeEnabled}
          unavailable={live.status !== "ready" ? "Disponible con el sidecar conectado." : !live.info?.voice ? "Falta configurar el reconocimiento de voz (ver setup.bat)." : wakeNote}
          state={state.wake?.state ?? "off"}
          readout={wakeReadout}
          onToggle={chooseWake}
          onEnrollmentChanged={() => wakeEnabled && void startWake()}
        />

        <h2>Memoria</h2>
        {live.status === "ready" ? (
          <MemoryPanel memory={memory} onForget={(id) => live.forgetMemory(id)} onClear={() => live.clearMemory()} onToggle={(on) => live.setMemoryEnabled(on)} />
        ) : (
          <p className="muted small">Disponible con el sidecar conectado.</p>
        )}

        <BenchRecorder onBusy={(busy) => wakeRef.current?.setPaused(busy)} />

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
