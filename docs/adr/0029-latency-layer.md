# ADR-0029: Capa de latencia — pensar desde las primeras palabras, voz por frases, muletillas honestas

**Estado:** aceptado · 2026-10-04

## Objetivo
Que el usuario **oiga a JARVIS en menos de 1 s** desde que deja de hablar; y que en tareas pesadas siempre haya algo útil que
oír. 100 % gratis. Pedido explícito: «que piense en la respuesta desde las primeras palabras, que no espere la oración completa».

## Línea base medida (con la voz del usuario: 35 grabaciones de `.jarvis/bench`, su config y APIs reales)
- Transcripción en carrera Groq + Gemini: **0,8–3,0 s** (Groq solo: ~400 ms; Gemini: ~1,4 s, hasta 5,5 s).
- Primer modelo elegido: `lfm-2.5` de OpenRouter, que respondía **429 en todas** las peticiones (80–350 ms perdidos escalando, cada vez).
- La voz esperaba el **final** de la respuesta (`task.finished`) antes de decir la primera palabra.
- Cada petición cargaba **~1.300 tokens** de definiciones de herramientas; con el límite gratis de Groq (~8.000 tokens/min)
  bastaban unas pocas preguntas seguidas para provocar 429 y escaladas de varios segundos.

## Decisiones (cada una con su medición)
1. **Escucha en streaming** (`voice.stream.start/chunk/end`, PCM16 16 kHz en trozos de ~200 ms) en push-to-talk y en la fase
   de orden de manos libres. El sidecar transcribe **parciales** con Groq mientras el usuario habla (`IncrementalTranscriber`:
   VAD con piso de ruido adaptativo, uno en vuelo, cada ~700 ms de audio nuevo o al detectar una pausa de 250 ms; presupuesto de
   12 parciales/min para no agotar los 20/min de whisper gratis). Subtítulos en vivo en la isla.
2. **Reuso del parcial**: si el último parcial empezó después de la última trama con voz (oyó todo) y es confiable, **es** la
   transcripción final: 0 ms de STT tras soltar (medido: 1–197 ms en esos casos, antes ~535 ms).
3. **Política de aceptación del texto rápido** (sin esperar a Gemini): «es una orden local, o la confianza de whisper ≥ 0,7».
   Simulada sobre las 35 grabaciones: **31/35 acciones correctas con mediana 431 ms** vs. 30/35 con 1.206 ms de la política
   anterior; umbrales 0,65–0,8 dan todos 31 (meseta). Con ella vino una regla determinista de un error sistemático medido:
   «abrí/abre/abrime» → «ahora/abril/a abrir» con confianza alta; esas palabras solo valen como «abrir» si las sigue una app
   conocida, y nunca se aprenden como alias.
4. **Especulación**: un parcial completo y confiable que no es orden local arranca el orquestador **a escondidas**
   (`HoldingBus` retiene los eventos; `RunOptions.speculation`). Mientras no se confirme: herramientas por encima de `read`
   esperan, no se escribe memoria/caché/estilo, y si se descarta se aborta (y el bucle no vuelve a llamar al modelo: bug de gasto
   de cuota encontrado por test). Al terminar de hablar: mismas palabras (sin puntuación/acentos/«jarvis») → se sueltan los
   eventos y la respuesta ya está en marcha; distintas → se descarta sin rastro. Máximo 2 conjeturas por enunciado. Las trazas
   la marcan (`speculation: committed|discarded`); el panel Economy no cuenta las descartadas como tareas pero sí su costo.
5. **Cierre de turno semántico** (manos libres): el detector esperaba 900 ms de silencio (menos cortaba frases, ADR-0019). Si el
   sidecar avisa que el parcial oyó todo, es confiable y whisper lo cerró con puntuación (`turnEnd`), el turno se cierra a los
   **450 ms**; cualquier voz nueva anula el aviso.
6. **Voz por frases**: `TaskSpeaker` dice cada oración apenas está completa (sin partir números como «1.560» ni bloques de
   código; mismo presupuesto de 3 frases/280 caracteres). Si ya dijo parte de un intento que luego escaló, la corrección empieza
   con «Mejor dicho:». Las tareas largas narran su progreso real cada ≥10 s.
7. **Salud de modelos** (`ModelHealth`, modelo estadístico en línea): un 429/5xx enfría el modelo (60 s para 429 o
   `Retry-After`, backoff exponencial hasta 15 min) y se saltea mientras haya otro; una EWMA del tiempo al primer token predice
   cuánto tardará cada modelo. Medido: tras el primer 429, la siguiente pregunta va directo al modelo sano.
8. **Modo rápido del proveedor**: en voz/especulación, gpt-oss se pide con `reasoning_effort: "low"` (medido: primer token
   424 → 207 ms en el 20b) y el prompt de voz pide empezar por la respuesta en una frase corta.
9. **Herramientas por petición** (`selectTools` + esquemas compactos): núcleo fijo (web, abrir apps, hora/fecha) y el resto solo
   si la frase lo sugiere (archivos, código, alias, memoria, MCP por nombre o palabra compartida). Medido: **1.118 → 641–669
   tokens de entrada (−42 %)**; las preguntas «de hoy» siguen usando la web.
10. **Muletillas honestas** (`FillerPolicy`, solo en conversación hablada): un acuse corto y variado («A ver…», «Dale.», «Buena
    pregunta.») **solo si la latencia predicha** (EWMA del modelo + primera frase + vuelta de herramienta) supera 600 ms; y una
    frase descriptiva cuando una herramienta lenta **realmente arranca** («Lo busco.», «Leo ambito.com.», «Le paso la tarea al
    agente…»). Nunca afirman resultados.

## Resultado (banco `pnpm --filter @jarvis/sidecar latency`, reproducción en tiempo real de las grabaciones)
| Modo | Primer audio posible p50 | p90 |
|---|---|---|
| Antes (clip entero al soltar) | 532 ms (solo órdenes locales; preguntas 1–3 s) | 625 ms |
| Push-to-talk en streaming | **403 ms** | 1.045 ms |
| Manos libres (incluye la espera de silencio) | **823 ms** (antes ~1.430) | 1.804 ms |
Más el arranque del sintetizador (voces locales de Windows: ~100–200 ms, sin medir en esta máquina).

## Descartado (medido)
- **Precalentar conexiones** (HEAD al proveedor al pulsar la tecla): frío ~210 ms vs. caliente ~155 ms; el HEAD ni siquiera
  recuperaba esos ~55 ms. No vale la complejidad.
- Especular sin pausa en push-to-talk: los parciales tardan ~400 ms y siempre van detrás de las últimas palabras; la mediana de
  silencio final en las grabaciones es de 140 ms (solo ~1/3 supera 250 ms). La ganancia en push-to-talk viene de 2, 3 y 10.

## Límites y riesgos
- Todo está calibrado con 35 grabaciones de una sola persona; los umbrales tienen meseta pero conviene re-medir con más uso.
- Los límites gratuitos siguen mandando: con la cuota agotada hubo una respuesta de 9 s (3 escaladas). El enfriamiento evita
  repetirlo, pero no crea cuota.
- Los parciales gastan llamadas de whisper (presupuesto configurable `voice.partialsPerMinute`); la especulación puede gastar
  una llamada de modelo que se descarta (máx. 2 por enunciado). Todo es desactivable: `voice.streaming`, `voice.speculate`,
  `voice.fillers`, `voice.fastAcceptConfidence`.
- **Sin probar con micrófono real**: el streaming de la isla y el cierre semántico están cubiertos por tests y por el banco a
  nivel sidecar; el tiempo de arranque del TTS de Windows no está medido.
- Un modelo propio entrenado no hizo falta: los «modelos» son estadísticos y en línea (salud/latencia, aceptación calibrada,
  fin de turno) y se pueden auditar.
