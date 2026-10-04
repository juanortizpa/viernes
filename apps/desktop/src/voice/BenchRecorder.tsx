import { useState } from "react";
import { startMic, MicUnavailable, type MicSession } from "./mic";
import { toBase64 } from "./pcm-buffer";

/** Phrases that look like what gets said to the assistant: commands, questions, voseo, a little English. */
export const BENCH_PHRASES = [
  "abre la calculadora",
  "qué hora es",
  "abrime el bloc de notas por favor",
  "decime qué día es mañana",
  "explicame qué es un closure en javascript",
  "creá un proyecto de api con tests",
  "cuál es la capital de Francia",
  "abre visual studio code",
  "qué respuestas guardadas tenés",
  "open the browser",
  "what time is it",
  "jarvis, abre paint",
] as const;

type Mode = "dsp-on" | "dsp-off";

interface Props {
  /** Pauses the always-on listener while a calibration clip is being recorded. */
  onBusy: (busy: boolean) => void;
}

/**
 * Records the phrases above with the browser's audio processing ON and then OFF, and stores them in `.jarvis/bench/` (dev bridge,
 * this machine only) so `check-stt.bat` can measure which speech-recognition settings work best for THIS voice and microphone.
 */
export function BenchRecorder({ onBusy }: Props) {
  const [mode, setMode] = useState<Mode>("dsp-on");
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string>();
  const [session, setSession] = useState<MicSession>();
  const [msg, setMsg] = useState<string>();

  const key = (phrase: string, m: Mode = mode) => `${m}:${phrase}`;
  const total = (m: Mode) => BENCH_PHRASES.filter((p) => saved[key(p, m)]).length;

  const begin = async (phrase: string) => {
    setMsg(undefined);
    setActive(phrase);
    onBusy(true);
    try {
      setSession(await startMic(() => {}, () => {}, mode === "dsp-on" ? "on" : "off"));
    } catch (e) {
      setActive(undefined);
      onBusy(false);
      setMsg(e instanceof MicUnavailable ? e.message : "No se pudo abrir el micrófono");
    }
  };
  const end = async (phrase: string) => {
    if (!session) return;
    const s = session;
    setSession(undefined);
    const buffer = await s.stop();
    setActive(undefined);
    onBusy(false);
    const wav = buffer.toWav();
    if (!wav) return setMsg("Muy corto: mantén pulsado mientras dices la frase completa");
    try {
      const res = await fetch("/__jarvis/bench/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phrase, mode, wav: toBase64(wav) }) });
      if (!res.ok) throw new Error(String(res.status));
      setSaved((x) => ({ ...x, [key(phrase)]: (x[key(phrase)] ?? 0) + 1 }));
    } catch {
      setMsg("No se pudo guardar (esto solo funciona con start.bat / pnpm dev)");
    }
  };

  return (
    <details className="bench">
      <summary>Prueba de transcripción (calibrar con tu voz)</summary>
      <p className="muted small">
        Graba cada frase <strong>como la dirías normalmente, a tu velocidad</strong> (no despacio). Haz una pasada con el procesamiento del navegador activado y otra desactivado; después ejecuta{" "}
        <code>check-stt.bat</code> y te dirá qué modelo y ajustes entienden mejor TU voz. Las grabaciones se quedan en esta carpeta (<code>.jarvis\bench</code>); nada sale del equipo.
      </p>
      <div className="bench__modes" role="radiogroup" aria-label="Pasada">
        {(["dsp-on", "dsp-off"] as const).map((m) => (
          <label key={m}>
            <input type="radio" name="bench-mode" checked={mode === m} onChange={() => setMode(m)} /> {m === "dsp-on" ? "Pasada 1: procesamiento ACTIVADO" : "Pasada 2: procesamiento DESACTIVADO"} ({total(m)}/{BENCH_PHRASES.length})
          </label>
        ))}
      </div>
      <ul className="bench__list">
        {BENCH_PHRASES.map((p) => (
          <li key={p}>
            <button
              type="button"
              className={`mic${active === p ? " mic--on" : ""}`}
              onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), void begin(p))}
              onPointerUp={() => void end(p)}
              onPointerCancel={() => void end(p)}
              aria-label={`Grabar: ${p}`}
            >
              🎙
            </button>
            <span>«{p}»</span>
            {saved[key(p)] ? <span className="muted small"> ✓ guardada{saved[key(p)]! > 1 ? ` (${saved[key(p)]})` : ""}</span> : null}
          </li>
        ))}
      </ul>
      {msg && <p className="small">{msg}</p>}
    </details>
  );
}
