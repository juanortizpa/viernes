import type { LiveStatus } from "../live/client";

interface Props {
  status: LiveStatus;
  lastError?: string;
  /** The sidecar has a speech-to-text engine. */
  voice: boolean;
  /** Microphone is open for push-to-talk. */
  talking: boolean;
  input: string;
  onInput: (text: string) => void;
  onSubmit: () => void;
  onTalkStart: () => void;
  onTalkStop: (discard?: boolean) => void;
  wakeEnabled: boolean;
  onToggleWake: (on: boolean) => void;
  onRetry: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  /** Global push-to-talk combination from the shell, if registered. */
  pttShortcut?: string | null;
}

/**
 * The island's own controls inside the Tauri window: one compact row under the island (⚙ opens `IslandSettings`).
 * It never shows progress of its own: the island above renders the sidecar's events.
 */
export function IslandDock({ status, lastError, voice, talking, input, onInput, onSubmit, onTalkStart, onTalkStop, wakeEnabled, onToggleWake, onRetry, settingsOpen, onToggleSettings, pttShortcut }: Props) {
  if (status !== "ready") {
    return (
      <div className="dock dock--status" role="status">
        <span className="dock__note">
          {status === "connecting" || status === "idle" ? "Arrancando el sidecar…" : `Sidecar no disponible${lastError ? `: ${lastError}` : ""}`}
        </span>
        {status === "unavailable" && (
          <button type="button" className="dock__btn" onClick={onRetry}>
            Reintentar
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="dock"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input className="dock__input" value={input} onChange={(e) => onInput(e.target.value)} placeholder="Escribe una orden…" aria-label="Orden para JARVIS" />
      <button
        type="button"
        className={`dock__btn mic${talking ? " mic--on" : ""}`}
        disabled={!voice}
        title={voice ? `Mantén pulsado para hablar (o ${pttShortcut ? pttShortcut.replace("Space", "Espacio") : "Ctrl+Espacio con la isla enfocada"})` : "Voz no configurada (ver setup.bat)"}
        aria-label="Pulsar para hablar"
        onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), onTalkStart())}
        onPointerUp={() => onTalkStop()}
        onPointerCancel={() => onTalkStop(true)}
      >
        🎙
      </button>
      <button
        type="button"
        className={`dock__btn${wakeEnabled ? " dock__btn--on" : ""}`}
        disabled={!voice}
        aria-pressed={wakeEnabled}
        title={wakeEnabled ? "Manos libres activado: el micrófono escucha «jarvis». Pulsa para apagarlo." : "Manos libres: escuchar «jarvis» (abre el micrófono de forma continua)"}
        onClick={() => onToggleWake(!wakeEnabled)}
      >
        👂
      </button>
      <button type="button" className={`dock__btn${settingsOpen ? " dock__btn--on" : ""}`} aria-pressed={settingsOpen} aria-label="Ajustes" title="Ajustes de voz y de la isla" onClick={onToggleSettings}>
        ⚙
      </button>
    </form>
  );
}
