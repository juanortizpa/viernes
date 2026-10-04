# ADR-0018: Palabra de activación en dos etapas + ventana de continuación

**Estado:** aceptado · 2026-10-04 · **Implementado y probado solo con audio SINTÉTICO** (ver "NO verificado").

## Contexto
Se pidió un esquema "como Siri/Google": un detector muy liviano que escuche cada ~0,2 s y, si ve parecido, lo pase a un modelo mejor (también liviano) que compruebe la palabra clave; solo entonces se transcribe la orden;
y después de una orden, seguir escuchando 10 s para no repetir "jarvis". Descartados: Porcupine (cuenta y clave externas, términos que no pude confirmar) y openWakeWord (más integración, sin probar). Se eligió una solución sin descargas ni cuentas.

## Decisión
**Etapa 1 — filtro en el equipo (`TemplateSpotter`).** Cada 200 ms compara los últimos 1,4 s contra **grabaciones de tu propia voz diciendo "jarvis"** (3 muestras): MFCC de 12 coeficientes + DTW de subsecuencia, sin modelo que descargar.
Es deliberadamente **permisivo** (prefiere un falso aviso a perderse la llamada) y **dependiente de tu voz** (también cumple "palabra personalizable"). Medido: **0,64 % de un núcleo** procesando audio continuo (bucle completo 0,23 %), **9 KB** de plantillas.
Sin voz registrada cae a `vad`: toda frase se verifica (más trabajo, avisado en la UI).
**Etapa 2 — verificación por transcripción.** El audio de la frase (hasta su silencio final) va al sidecar, que la transcribe con **whisper tiny** (`voice.wakeModel`, prompt "Jarvis.") y exige que **empiece** por la palabra (`matchWakeWord`: tolera "hey/oye", "yarvis/harvis…" y una letra de error; "le dije a jarvis…" no activa).
Si en la misma frase venía la orden ("jarvis abre la calculadora") **se ejecuta esa misma transcripción** (una sola pasada). Si no, la UI pasa a "Dime…" y captura la orden con un endpointer por silencio (600 ms, máx. 10 s).
**Ventana de continuación (10 s).** Cuando termina una tarea **iniciada por voz** y se ha terminado de **hablar la respuesta**, se abre una ventana de 10 s (cuenta atrás visible y real) en la que la siguiente frase es una orden **sin** decir "jarvis". Nunca se corta a alguien a mitad de frase; cada orden reabre la ventana. Una tarea escrita no reabre el micrófono.

Máquina de estados pura (`WakeController`: off → idle → verifying → command → busy → followUp → idle) con entradas/salidas explícitas y reloj inyectado, probada sin navegador.

## Privacidad (reglas)
- **Opt-in**, apagado por defecto; interruptor visible; el punto rojo ● de la isla y el icono del navegador/Windows indican que el micrófono está abierto; apagar lo cierra de verdad.
- El audio vive en la memoria de la pestaña. Solo sale (hacia el sidecar local) una frase que el filtro dio por probable, y luego la orden. **Una frase que no empieza por la palabra se descarta: su texto no se guarda, no se registra ni se devuelve** (hay test).
- Tus plantillas (características MFCC, no audio) se guardan en `localStorage` de este navegador y se pueden borrar en la UI.
- Mientras el asistente habla se **ignora el micrófono** (no se oye a sí mismo) y la ventana de 10 s empieza cuando termina de hablar. Eco/ruido del navegador activados.

## NO verificado (importante)
- **Ningún audio de voz real.** Las pruebas usan sonidos sintéticos tipo vocal (tren de pulsos por resonadores). Demuestran la mecánica, la discriminación relativa (la palabra puntúa ~1,9 y otras frases 2,9–4,6) y la máquina de estados end-to-end en Chromium con micrófono simulado. **No demuestran** precisión con tu voz, tu micrófono, tu ruido de fondo ni tu acento.
- El umbral automático (peor repetición propia ×1,3) resultó **justo** con audio distinto del de registro; por eso hay un control de **sensibilidad** y un indicador "puntaje / dispara con ≤" para calibrar en vivo. Hay que ajustarlo en Windows.
- Falsos negativos: si la etapa 1 no dispara, no hay nada que la rescate. Falsos positivos: los filtra la etapa 2, pero cada uno cuesta una transcripción tiny.
- Calidad de whisper tiny reconociendo "Jarvis" (no es una palabra del español: puede salir "Yarvis", "Harvis", "Garvis"; hay variantes aceptadas pero no medidas).
- **Ventana de 10 s**: durante ella cualquier voz (una TV, otra persona) puede ejecutarse como orden. Los permisos y el policy engine siguen mandando, pero conviene que lo sepas.
- Sin cancelación de eco real: se confía en que se ignora el micrófono mientras habla. Interrumpir **por voz** al asistente no está soportado (Esc/Callar/botón sí).
- Consumo real en Windows (WebView2/Edge) y en portátil con batería: sin medir; el 0,64 % es de Node.

## Consecuencias
+ Sin cuentas, sin descargas nuevas (solo whisper tiny, ya usado), costo en reposo mínimo, palabra personalizable. + Etapa 2 reutiliza el sidecar existente.
− Dependiente de tu voz y de tu micrófono; requiere registro y calibración. − Latencia: se verifica al terminar la frase (+≈0,6 s de silencio) y luego la transcripción.
