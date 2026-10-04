import { useState } from "react";
import { EnrollmentError, enroll, enrollmentToJson } from "@jarvis/voice/audio";
import { MicUnavailable, startMic, type MicSession } from "./mic";
import { WAKE_ENROLLMENT_KEY, WAKE_SENSITIVITY_KEY, loadEnrollment, loadSensitivity } from "./wake-session";

const SAMPLES_NEEDED = 3;

interface Props {
  enabled: boolean;
  /** Why it cannot run (sidecar offline, no speech engine). */
  unavailable?: string;
  state: string;
  /** Live stage-1 readout (score vs threshold) to help calibrate; polled while enabled. */
  readout?: string;
  onToggle: (enabled: boolean) => void;
  /** Called after the stored voice changed so the running session can pick it up. */
  onEnrollmentChanged: () => void;
}

/** Hands-free controls: the on/off switch (a visible, honest one) and the three-sample voice enrolment. */
export function WakeSettings({ enabled, unavailable, state, readout, onToggle, onEnrollmentChanged }: Props) {
  const [enrolled, setEnrolled] = useState(() => loadEnrollment() !== undefined);
  const [samples, setSamples] = useState<{ samples: Float32Array; sampleRate: number }[]>([]);
  const [recording, setRecording] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [session, setSession] = useState<MicSession>();
  const [sensitivity, setSensitivity] = useState(loadSensitivity);

  const begin = async () => {
    setMsg(undefined);
    setRecording(true);
    try {
      setSession(await startMic(() => {}, () => {}));
    } catch (e) {
      setRecording(false);
      setMsg(e instanceof MicUnavailable ? e.message : "No se pudo abrir el micrófono");
    }
  };
  const end = async () => {
    if (!session) return;
    const s = session;
    setSession(undefined);
    setRecording(false);
    const pcm = (await s.stop()).toPcm16k();
    if (!pcm) return setMsg("Muy corto: mantén pulsado mientras dices «jarvis»");
    const next = [...samples, pcm];
    if (next.length < SAMPLES_NEEDED) return (setSamples(next), setMsg(undefined));
    try {
      const e = enroll(next);
      localStorage.setItem(WAKE_ENROLLMENT_KEY, enrollmentToJson(e));
      setEnrolled(true);
      setSamples([]);
      setMsg("Voz registrada. Si el modo manos libres está activo, ya la usa.");
      onEnrollmentChanged();
    } catch (err) {
      setSamples([]);
      setMsg(err instanceof EnrollmentError ? `${err.message}. Empieza de nuevo.` : "No se pudo registrar la voz");
    }
  };
  const forget = () => {
    try {
      localStorage.removeItem(WAKE_ENROLLMENT_KEY);
    } catch {
      /* nothing stored */
    }
    setEnrolled(false);
    setSamples([]);
    setMsg("Voz borrada.");
    onEnrollmentChanged();
  };

  return (
    <section className="wake" aria-label="Manos libres">
      <label className="wake__toggle">
        <input type="checkbox" checked={enabled} disabled={Boolean(unavailable)} onChange={(e) => onToggle(e.target.checked)} /> Escuchar «jarvis» (manos libres)
      </label>
      <p className="muted small">
        {unavailable ?? (enabled ? `Micrófono abierto · estado: ${state}. El audio se analiza en este equipo; solo se envía al sidecar (también local) lo que parece que dices «jarvis».` : "Apagado: el micrófono está cerrado.")}
      </p>
      {enabled && readout && <p className="muted small wake__readout" data-testid="wake-readout">{readout}</p>}
      <div className="wake__enroll">
        <button
          type="button"
          className={`mic${recording ? " mic--on" : ""}`}
          onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), void begin())}
          onPointerUp={() => void end()}
          onPointerCancel={() => void end()}
          aria-label="Mantén pulsado y di jarvis"
        >
          🎙
        </button>
        <span className="muted small">
          {enrolled && samples.length === 0 ? "Tu voz está registrada (el filtro rápido la usa)." : `Registrar mi voz: mantén pulsado y di «jarvis» — muestra ${samples.length + 1} de ${SAMPLES_NEEDED}.`}
          {!enrolled && " Sin registro, cada frase que oiga se verifica (más trabajo)."}
        </span>
        {enrolled && (
          <button type="button" className="btn btn--ghost" onClick={forget}>
            Borrar mi voz
          </button>
        )}
      </div>
      {enrolled && (
        <label className="wake__sens small">
          Sensibilidad del filtro rápido: {sensitivity.toFixed(1)}
          <input
            type="range"
            min={0.8}
            max={2.5}
            step={0.1}
            value={sensitivity}
            onChange={(e) => setSensitivity(Number(e.target.value))}
            onPointerUp={() => {
              try {
                localStorage.setItem(WAKE_SENSITIVITY_KEY, String(sensitivity));
              } catch {
                /* session-only */
              }
              onEnrollmentChanged();
            }}
            aria-label="Sensibilidad"
          />
          <span className="muted"> Di «jarvis» y mira el puntaje: debe bajar de «dispara con». Si no baja, sube la sensibilidad; si se activa con cualquier cosa, bájala.</span>
        </label>
      )}
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}
