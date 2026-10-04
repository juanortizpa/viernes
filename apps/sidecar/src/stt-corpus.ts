// Speech-recognition evaluation corpus (ADR-0020): phrases with their expected action, and a deterministic mic degradation.
import { decodeWav, encodeWav } from "@jarvis/voice";

/** Phrase, and the ACTION it must end in ("llm" = answered by the model). */
export const STT_CORPUS: readonly { text: string; expect: string }[] = [
  { text: "abre la calculadora", expect: "apps.open:calc" },
  { text: "che, abrime la calculadora", expect: "apps.open:calc" },
  { text: "abrime el bloc de notas por favor", expect: "apps.open:notepad" },
  { text: "qué hora es", expect: "time.now" },
  { text: "decime qué día es mañana", expect: "time.date:1" },
  { text: "explicame qué es un closure en javascript", expect: "llm" },
  { text: "creá un proyecto de api con tests en python", expect: "llm" },
  { text: "cuál es la capital de Francia", expect: "llm" },
  { text: "abre visual studio code", expect: "apps.open:code" },
  { text: "eh, abrime el, el paint", expect: "apps.open:mspaint" },
  { text: "qué respuestas guardadas tenés", expect: "llm" },
  { text: "open the browser", expect: "apps.open:msedge" },
  { text: "what time is it", expect: "time.now" },
  { text: "jarvis, abre paint", expect: "apps.open:mspaint" },
  { text: "recordame comprar leche mañana a la mañana", expect: "llm" },
  { text: "abrí teams", expect: "llm" },
  { text: "buscá en google cómo hacer pan casero", expect: "llm" },
  { text: "olvidá mi estilo", expect: "llm" },
  { text: "necesito que me abras el explorador de archivos", expect: "apps.open:explorer" },
  { text: "contame un chiste corto", expect: "llm" },
];

/** Laptop-microphone-like degradation: band-limit ~250-5500 Hz plus room noise at ~12 dB SNR. Deterministic. */
export function degrade(wav: Uint8Array): Uint8Array {
  const x = decodeWav(wav).samples;
  const y = new Float32Array(x.length);
  const aLp = Math.exp((-2 * Math.PI * 5500) / 16000);
  const aHp = Math.exp((-2 * Math.PI * 250) / 16000);
  let lp = 0, hp = 0, prev = 0, brown = 0, seed = 7, sig = 0;
  for (const v of x) sig += v * v;
  sig = Math.sqrt(sig / Math.max(1, x.length));
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5;
  const noise = sig / 10 ** (12 / 20);
  for (let i = 0; i < x.length; i++) {
    lp = (1 - aLp) * x[i]! + aLp * lp;
    hp = aHp * (hp + lp - prev);
    prev = lp;
    brown = 0.98 * brown + rnd() * 0.2;
    y[i] = hp + noise * (rnd() * 0.6 + brown * 1.4);
  }
  return encodeWav({ samples: y, sampleRate: 16000 });
}

