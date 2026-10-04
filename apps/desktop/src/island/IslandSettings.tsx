import type { ReactNode } from "react";
import { SPEAK_MODES, parseSpeakMode, type SpeakMode } from "../speech/policy";
import type { AudioDsp } from "../voice/audio-settings";

interface Props {
  speakMode: SpeakMode;
  onSpeakMode: (m: SpeakMode) => void;
  /** The webview has a speech synthesiser. */
  speech: boolean;
  audioDsp: AudioDsp;
  onAudioDsp: (v: AudioDsp) => void;
  /** Global push-to-talk combination, null when the OS refused it, undefined while unknown. */
  pttShortcut?: string | null;
  /** The hands-free block (`WakeSettings`), shared with the browser panel. */
  wake: ReactNode;
  onHide: () => void;
  onClose: () => void;
}

const shortcutLabel = (s: string) => s.replace("Space", "Espacio");

/** Voice settings inside the island (the browser panel has the same controls plus calibration tools). */
export function IslandSettings({ speakMode, onSpeakMode, speech, audioDsp, onAudioDsp, pttShortcut, wake, onHide, onClose }: Props) {
  return (
    <section className="island-settings" aria-label="Ajustes de JARVIS">
      <header className="island-settings__head">
        <strong>Ajustes</strong>
        <button type="button" className="dock__btn" onClick={onClose} aria-label="Cerrar ajustes">
          ✕
        </button>
      </header>
      <p className="island-settings__row">
        {pttShortcut
          ? `Mantén ${shortcutLabel(pttShortcut)} para hablar desde cualquier app.`
          : pttShortcut === null
            ? "El atajo global para hablar no está disponible (otra app lo usa). Con la isla enfocada: Ctrl+Espacio."
            : ""}
      </p>
      <label className="island-settings__row">
        Hablar:{" "}
        <select value={speakMode} disabled={!speech} onChange={(e) => onSpeakMode(parseSpeakMode(e.target.value))}>
          {SPEAK_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {!speech && <span className="muted small"> · sin síntesis de voz en este equipo</span>}
      </label>
      <label className="island-settings__row">
        Audio del micrófono:{" "}
        <select value={audioDsp} onChange={(e) => onAudioDsp(e.target.value === "off" ? "off" : "on")}>
          <option value="on">Procesado (cancela ruido y eco)</option>
          <option value="off">Crudo (sin procesar)</option>
        </select>
      </label>
      {wake}
      <p className="island-settings__foot">
        <button type="button" className="dock__btn" onClick={onHide}>
          Ocultar isla
        </button>
        <span className="muted small">Vuelve desde el icono de la bandeja o con el atajo para hablar.</span>
      </p>
    </section>
  );
}
