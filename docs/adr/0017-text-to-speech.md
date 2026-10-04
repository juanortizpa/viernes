# ADR-0017: Respuestas habladas (TTS) con las voces del sistema

**Estado:** aceptado · 2026-10-04 · **Alcance:** salida de voz en la UI. Wake word sigue pendiente.

## Decisión
- **Voces del sistema, cero descargas:** `speechSynthesis` del navegador/WebView2 (Windows trae voces locales; Edge además ofrece voces "Natural" en línea, que **sí envían el texto a Microsoft**: se prefieren las locales, ver abajo). Un TTS neuronal propio (Piper, etc.) queda como mejora si la calidad no basta.
- **Qué se dice** lo decide `TaskSpeaker` solo a partir de `OrchestratorEvent`s (no inventa contenido): el **acuse** de R1 al instante (por fin se oye mientras el modelo trabaja), luego la respuesta final
  (solo el último intento tras un escalado), una confirmación breve para acciones locales ("Listo.", la hora), "No pude completarlo." ante un fallo y "Necesito tu permiso." cuando hay un prompt.
  No se lee el resumen técnico en inglés de las herramientas (`opened calc`).
- **Texto hablable:** sin markdown, sin URLs ("un enlace"), **sin código ni tablas** (se dice "Te dejé el detalle en pantalla"), máx. 3 frases / 280 caracteres.
- **Política:** `Solo si hablo` (por defecto: se responde en voz cuando la petición fue por voz), `Siempre`, `Nunca`; se recuerda en `localStorage`.
- **Interrupción (barge-in):** una tarea nueva, empezar a hablar (push-to-talk), `Esc` o el botón *Callar* cortan al instante y vacían la cola; los callbacks tardíos de lo cancelado no avanzan la cola.
  Las frases van en cola para que el acuse no se corte con la respuesta.
- **Elección de voz:** por idioma de la frase; español rioplatense primero (hablas con voseo), luego MX/US/CO/ES; locales antes que en línea. Si no hay voz para ese idioma, **se calla y lo dice** en la UI (no lee español con voz inglesa).
- **Estado real:** el cuervo abre y cierra el pico y la isla muestra "🔊 hablando" solo cuando el sintetizador **informa** que empezó (`onstart`), no cuando se pidió; la isla no se pliega mientras habla.
- **Métrica time-to-first-audio:** desde `task.started` hasta el primer `onstart`, visible en el panel ("primer audio: N ms tras enviar").

## Verificado
- 17 tests nuevos (texto hablable, voces, política, cola/cancelación del controlador, `TaskSpeaker` con eventos).
- Chromium con un sintetizador simulado: acuse → respuesta en orden, Esc corta, los 3 modos, la elección persiste, el chip "hablando" aparece.

## NO verificado
- **Audio real**: no hay voces en el entorno de desarrollo. Calidad, volumen, qué voces trae tu Windows, y si WebView2/Tauri expone `speechSynthesis` igual que el navegador. El 50 ms de la métrica es del simulador, no es una medida real.
- **Eco**: con altavoces, el micrófono podría oír al asistente. Hoy se evita porque el push-to-talk es manual y corta el habla al pulsar; con wake word (escucha continua) habrá que resolverlo antes (cancelación de eco o silenciar la escucha mientras habla).
- Las voces en línea de Edge envían texto a un servicio externo; no hay hoy un filtro que las excluya (solo se prefieren las locales dentro de cada región, así que una voz en línea `es-AR` gana a una local `es-MX`).

## Consecuencias
+ La latencia percibida baja mucho (acuse hablado). + Sin dependencias nuevas. − Calidad dependiente del sistema. − Una voz en línea puede mandar el texto fuera.
