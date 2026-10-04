# ADR-0019: Calidad de transcripción y calibración con la voz del usuario

**Estado:** aceptado · 2026-10-04 · **Origen:** el usuario reporta que "hay que hablar muy despacio y claro" para que transcriba bien.

## Hipótesis y qué se cambió (todas verificadas con tests, ninguna medida aún con voz real)
1. **Se perdía audio mientras se verificaba «jarvis».** Durante la verificación (≈0,5–1,5 s) se ignoraba el micrófono: la orden dicha tras una pausa llegaba sin su principio. Ahora el `WakeController` **sigue capturando mientras verifica**, retiene la orden y la envía en cuanto se confirma la palabra (o descarta todo si no era para él; hay tests de cada caso).
2. **Se cortaban frases en pausas naturales.** El fin de frase de las órdenes pasó de 600 a **900 ms** (el de la palabra de activación sigue en 600). Una pausa de 700 ms dentro de una orden ya no la parte.
3. **Remuestreo burdo.** Bajar de 44,1/48 kHz a 16 kHz con un promedio deja pasar aliasing. Ahora es un **FIR pasa-bajos (sinc con ventana)**: un tono de 10 kHz queda >28 dB por debajo y 3× menos que antes; 1 kHz pasa intacto (tests).
4. **Audio crudo a whisper.** Antes de transcribir el sidecar **nivela** la voz (~−22 dBFS, máx. +24 dB, sin recortar, sin amplificar ruido) y añade **300 ms de silencio** a cada lado.
5. **Beam search** configurable (`voice.beamSize`, 5 por defecto; 1 = más rápido). Verificación de «jarvis» con beam 1.
6. **Prompt de vocabulario:** pasó de "abre X, abre Y…" (repite "abre", invita a bucles) a una sola frase natural; se puede apagar con `"prompt": ""`. **No sé si ayuda o perjudica**: la calibración lo mide.
7. **Push-to-talk:** ya no dice «Escuchando…» antes de que el micrófono esté realmente abierto (el primer instante se perdía); ahora muestra «Preparando micrófono…».
8. **Modelo:** `setup.bat` descarga **`small`** por defecto (≈470 MB) en lugar de `base`; en español `small` suele reducir bastante el error. Cuesta más tiempo por frase: el acuse hablado de R1 oculta parte de la espera. Se puede volver a `base` con `--model base`.

## Calibración con tu voz (`check-stt.bat`)
Como no puedo medir tu voz, hay una herramienta para decidir con datos:
- En la app, **«Prueba de transcripción»**: graba 12 frases típicas (comandos, voseo, algo de inglés) **a tu velocidad normal**, con el procesamiento de audio del navegador ACTIVADO y luego DESACTIVADO. Se guardan en `.jarvis\bench` (solo en tu equipo).
- `check-stt.bat` prueba cada modelo instalado con los ajustes de producción y luego cambia **un factor a la vez** (procesamiento previo, prompt, beam) y mide **error de palabras (WER)** y latencia. Imprime una tabla, escribe `.jarvis\bench\report.md` y con `--apply` deja la mejor configuración en `jarvis.config.json`.
- El interruptor **«Audio del navegador»** (procesado / crudo) existe porque la supresión de ruido del navegador está pensada para llamadas y puede borronear consonantes; la calibración dice cuál va mejor en tu micrófono. Si lo cambias, hay que **volver a registrar tu voz** de «jarvis».

## NO verificado
- Todo lo anterior se verificó con tests y audio sintético, y la herramienta con un binario de mentira; **la mejora real de precisión con tu voz no está medida**. Puede que el cuello de botella sea el modelo, el micrófono o el ruido, no mis cambios.
- Los efectos del prompt y del procesamiento del navegador son hipótesis hasta que `check-stt.bat` los mida.
- Con `small`, la latencia por frase sube; no está medida en tu CPU.
- Si tras calibrar sigue siendo malo, las siguientes palancas son un modelo mayor (`medium`, o `large-v3-turbo` cuantizado), un micrófono mejor/headset, y VAD más fino; cada una con su coste.
