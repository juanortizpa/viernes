# ADR-0020: Transcripción en la nube (gratis) en carrera + "entendí lo que quisiste decir"

**Estado:** aceptado · 2026-10-04 · Sustituye la elección de motor de ADR-0016/0019 cuando hay claves (el whisper local queda como respaldo).

## Contexto
Con audio crudo y `small` local seguía habiendo "muchos errores". El usuario pide el mejor modelo ligero y gratis, y que entienda lo que quiso decir aunque lo diga confuso.

## Cómo se decidió: medición, no intuición
- **Corpus de voz natural:** 20 frases rioplatenses (órdenes, preguntas, voseo, titubeos, inglés) sintetizadas con 8 voces del TTS de Gemini; condición **limpia** y **degradada** (banda de micrófono de portátil 250–5500 Hz + ruido a ~12 dB SNR). Se mide **error de palabras** y, sobre todo, **si la orden termina en la acción correcta** (abrir la app correcta, dar la hora, ir al modelo).
- Hallazgo de método: los TTS nuevos **leen en voz alta** las instrucciones de estilo ("dilo rápido…"); 6 clips contaminados se detectaron y regeneraron con texto plano.

| Motor | Error de palabras (limpio / degradado) | Acción correcta (limpio / degradado) | Latencia |
|---|---|---|---|
| Groq whisper-large-v3-turbo | 19–22 % / 22 % | 15/20 / 15/20 | ~0,5 s |
| Groq whisper-large-v3 | 25 % / 22 % | — | ~0,5 s |
| Gemini 3.1 flash-lite ("oído + entendido") | 6,3 % / 9,1 % | 18/20 / 18/20 | 1,5 s… **hasta 19 s** (variable) |
| **Gemini 3.5 flash-lite** ("oído + entendido") | **7,1 % / 5,6 %** | **18/20 / 19/20** | **~1,3 s** |
| **Producción: carrera Groq + Gemini 3.5** | — | **20/20 / 19/20** | **mediana 1,2 s** (0,5 s en órdenes claras; máx. 1,6 s) |

## Decisión
- **`voice.engine: "auto"` (por defecto):** Groq whisper-turbo y Gemini 3.5 flash-lite **en paralelo** (`RaceTranscriber`). Si lo que oyó Groq ya es una orden local inequívoca (el mismo router determinista), se ejecuta al instante (~0,5 s) y se cancela Gemini. Si no, se usa la interpretación de Gemini (espera máx. 2,5 s; si tarda más, el texto de Groq). Si las dos nubes fallan → **whisper local** (`FallbackTranscriber`); un 429 salta ese motor hasta su `retry-after`.
- **"Entendí lo que quisiste decir":** Gemini devuelve en una llamada `heard` (literal) y `meant` (corrige errores de reconocimiento, quita muletillas, prefiere nombres de tus apps). **Salvaguarda:** si `meant` añade más de 3 palabras a lo oído, se usa lo oído (no inventa órdenes). La isla muestra "Entendí: … (oí: …)".
- **Capa determinista (instantánea, sin red):** el router quita muletillas/titubeos/repeticiones ("che", "eh", "el, el"), entiende prefijos hablados ("decime…", "me podés decir…", "necesito que me abras…") y busca apps **por sonido** (`phoneticKey`: "bróser"≈browser, "blog de notas"≈bloc). El lanzador acepta un nombre que suene igual solo si es **único**.
- **Prompt de whisper solo "Jarvis.":** MEDIDO — con una lista de apps como prompt, whisper **regurgitó la lista**: "jarvis, abre paint" salió como *"Jarvis, abre la calculadora, el navegador, Teams."* (habría abierto otra app). Las apps se resuelven después del reconocimiento.
- **Orden dicha junto a "jarvis":** se verifica con el motor rápido y la orden se **re-transcribe con el motor bueno**; se ejecuta el texto bueno (un bug que ejecutaba el texto rápido fue atrapado por un test).
- **El LLM sabe que es voz:** en tareas por voz el prompt del sistema avisa que el texto puede traer errores de reconocimiento e indica interpretar (o preguntar si es ambiguo).
- **`voice.engine: "local"`** = el audio nunca sale del equipo. `"groq"` / `"gemini"` = solo esa nube.
- Herramienta de regresión: `pnpm --filter @jarvis/sidecar exec tsx src/stt-eval.ts gen|run`; `check-stt.bat` ahora compara también Groq, Gemini y la carrera con **tu** voz.

## Privacidad
Con `auto`, el audio de cada orden va a **Groq y a Google** (planes gratuitos). El plan gratuito de Google puede usar los datos para mejorar sus productos (ver ADR-0014); revisa también los términos de Groq. La palabra de activación se verifica en local (tiny) si está instalado. Para privacidad total: `"engine": "local"`.

## NO verificado / límites
- **Voz sintética, no la tuya.** Las cifras son de voces TTS; tu acento, tu micrófono y tu ruido pueden dar otros números. Por eso `check-stt.bat` existe.
- 20 frases es una muestra pequeña. La latencia de Gemini **varía mucho** entre momentos (3.1 pasó de 1,5 s a 19 s en la misma tarde): la espera máxima de 2,5 s lo acota.
- Cuotas gratuitas (aprox., cambian): Groq ~20 peticiones/min; Gemini flash-lite ~15/min. Cada orden por voz usa una de cada. El respaldo local cubre los cortes.
- Clip que sigue fallando: "qué hora es" dicho muy rápido por una voz → "¿Qué es?". Ningún motor lo resolvió.
