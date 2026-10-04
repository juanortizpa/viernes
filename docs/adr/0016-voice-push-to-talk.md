# ADR-0016: Voz — push-to-talk con STT local (whisper.cpp)

**Estado:** aceptado · 2026-10-04 · **Alcance:** solo entrada de voz (STT). TTS y wake word quedan fuera.

## Contexto
La Fase 7 planteaba push-to-talk → STT local → respuesta. Se adelanta la entrada de voz porque es lo más fácil de validar y encaja con el acuse de R1.
La detección continua de "jarvis" (wake word) escucha siempre y añade riesgos de privacidad y falsos disparos, así que va después.

## Decisión
- **El micrófono solo se abre mientras se mantiene pulsado** el botón o Ctrl+Espacio y se libera al soltar (el indicador del sistema es veraz). Esc descarta la grabación.
- **STT local, el audio no sale de la máquina.** `packages/voice`: interfaz `Transcriber`; adaptador `WhisperCppTranscriber` que lanza el CLI de whisper.cpp por **argv, sin shell**,
  con WAV en un directorio temporal privado que se borra siempre, timeout y cancelación. **El binario y el modelo los pone el usuario** (`voice.binary`, `voice.model`);
  el proyecto no descarga ni compila nada solo. Sin configuración, la voz se declara no disponible (`hello.ok.voice=false`) y la UI deshabilita el botón.
- **Puerta de silencio antes del motor** (`prepareClip`): decodifica, exige 0.3–20 s, normaliza a 16 kHz mono y rechaza clips sin energía de voz. Los motores tipo Whisper inventan
  frases en silencio ("Gracias por ver el video"); esas nunca llegan a ellos. Probado con un motor que *alucinaría*.
- **IPC** (`voice.submit` → `voice.transcribed` | `voice.rejected`): el sidecar transcribe, informa qué escuchó y ejecuta el texto como tarea `modality: "voice"` por el mismo
  camino que el texto escrito (mismo policy engine, mismo router, mismos acuses). `task.cancel` aborta también una transcripción en curso. Los errores internos del motor
  (rutas, mensajes) se registran en el log del sidecar y no se muestran al usuario.
- **Estados de la UI = lo que realmente pasa:** `Escuchando…` solo con el micrófono abierto (el cuervo anima aros con el **nivel real** de entrada), `Transcribiendo…` solo mientras
  el sidecar trabaja. No son eventos del orquestador: son acciones locales del reducer, separadas de `OrchestratorEvent`.
- Límite de línea IPC subido a 2 MB (un clip de 20 s en base64 ≈ 0.85 MB).

## Verificado
- Tests nuevos (WAV, remuestreo, puerta de silencio, adaptador con un proceso real que hace de binario —incluye que `$(…)` y `;` en el texto quedan como datos—, flujo IPC, cancelación).
- Chromium con micrófono simulado: mantener → `Escuchando…` → soltar → transcripción → la orden "qué hora es" se ejecuta por la ruta local. Cancelar durante una transcripción lenta funciona.

## NO verificado (importante)
- **No he probado reconocimiento de voz real.** Los binarios que usé para probar son *stand-ins* que imprimen una frase fija; no reconocen nada. Falta ejecutar whisper.cpp con tu binario y modelo
  y medir precisión en español/inglés y latencia (tamaño de modelo vs CPU). El intento de compilar whisper.cpp en el entorno de desarrollo fue denegado por el sistema de permisos y no se insistió.
- Micrófono real (calidad, ganancia, eco), permisos del micrófono en WebView2 y el atajo **global** (la ventana Tauri no tiene foco): requieren Windows. Hoy Ctrl+Espacio solo funciona con la ventana enfocada.
- En Tauri la UI aún no conecta con el sidecar (pendiente el relevo stdio↔eventos, Fase 1), así que la voz solo funciona en el modo navegador/dev.

## Consecuencias
+ Voz sin nube y sin coste por uso. + Mismo pipeline que el texto. − Latencia depende del modelo y la CPU; el acuse de R1 ayuda a ocultarla.
− Whisper no es streaming: se transcribe al soltar (decisión de MVP; streaming sería V2).
