# ADR-0015: Capa de respuesta inmediata (acuse + respuestas locales + caché semántico)

**Estado:** aceptado · 2026-10-04 (R1 y R2 implementados y verificados; R3 en curso)

## Contexto
Hoy toda consulta que no es un intent local espera al modelo (0,5–40 s según el proveedor, ver informe del arnés).
Saludos y cortesías no necesitan un LLM, y en tareas largas el usuario no ve nada hasta que el modelo responde.
Idea del usuario: un componente muy liviano (<100 MB) que conozca las preguntas frecuentes y el estilo del usuario,
responda al instante lo repetitivo y, ante algo largo, acuse rápido ("ya me pongo con eso") mientras el modelo trabaja.

## Decisión (por sub-fases; cada una se valida antes de seguir)
- **R1 — Acuse y respuestas fijas (MVP, sin modelo, sin entrenamiento).** Plantillas/reglas ES/EN, estilo del
  intent router. Dos salidas: (a) respuesta completa para saludos y cortesías (`reply`); (b) *acuse* (`ack`) cuando el router
  clasifica la tarea como larga o con herramientas. El acuse **no es progreso falso**: es un evento nuevo del
  orquestador (`instant.issued`, con `kind: reply|ack`) emitido por el mismo camino que el resto, y declara que solo confirma recepción.
- **R2 — Caché semántico.** Implementado con un embedder sin dependencias (n-gramas hasheados, 512 dim) detrás de la interfaz `Embedder`, más una
  guarda de contenido; un embedding neuronal (≈20–80 MB) queda como sustituto solo si los datos lo justifican. Almacenamiento en SQLite (`node:sqlite`).
- **R3 — Modelo de estilo/preferencias (Investigación).** Solo si R2 muestra valor medible. Por defecto, las
  preferencias viven como memoria de Fase 5 inyectada al prompt, no como un modelo entrenado.

## Reglas duras (no negociables)
1. **Una sola puerta, determinista:** la decisión de servir desde la capa inmediata la toma código, no un LLM.
2. **Lista de exclusión:** nunca se sirve desde caché lo que dependa del tiempo o del estado (hora, fecha, archivos,
   apps, clima), lo que use herramientas, ni lo que `detectSensitive` marque.
3. **Qué entra al caché:** solo respuestas con veredicto de éxito, sin taint (ADR-0005) y sin datos sensibles.
   Una respuesta del propio caché no se vuelve a guardar.
4. **Transparencia:** toda respuesta servida localmente se etiqueta en UI y en la traza (`source: instant`),
   con costo 0 (`ExecutionTrace.instant`) y sin `propensity` de modelo; no se mezcla con los modelos en el análisis del arnés.
5. **Control del usuario:** ver, borrar y desactivar lo guardado (se integra con Fase 5).
6. **Presupuesto:** <100 MB en disco, latencia objetivo <50 ms en acierto; si el índice crece, se poda por uso/antigüedad.

## Riesgos
- Falso positivo del caché (responde la pregunta equivocada): peor que no tener caché. Se mide con el arnés
  (tasa de aciertos vs. correcta contra el modelo) antes de activar R2; umbral conservador y ante duda se va al modelo.
- Acuse que promete algo que luego falla: el texto del acuse no afirma resultados, solo recepción.
- Datos personales en el caché: cifrado/permisos del archivo como el resto de SQLite local.

## Consecuencias
+ Sensación de inmediatez barata, ahorro de llamadas en lo repetitivo. + R1 casi no cuesta y cubre la mayor parte del efecto.
− Un contrato de evento nuevo (`ack.issued`) que la UI debe soportar. − R2 añade una dependencia de embeddings.

## Implementación R1 (hecho)
- `packages/core/src/instant.ts`: `RuleInstantResponder` (frases exactas normalizadas ES/EN; tolera signos, acentos y "jarvis";
  cualquier mensaje con una petición adicional NO se captura). Acuse solo si `needsTools`, complejidad ≥0.6 o prompt >400 car.
- El orquestador emite `intent.resolved(route=local, intent=instant.reply)` + `instant.issued` y termina sin modelo; el acuse se emite
  antes de `route.decided`. Activable con `instantResponses` (por defecto sí) en la config del sidecar.
- Medido con Groq real: saludo 1 ms sin red; acuse a 1 ms vs primer token del modelo a ~1030 ms.
- Límite conocido: las respuestas son fijas (sin variación) y el idioma del acuse se decide por heurística de palabras.

## Implementación R2 (hecho)
- `packages/core/src/instant-cache.ts`: `SemanticCache` (+ `HashedNgramEmbedder`, `isCacheable`, `sameContent`), `SqliteInstantStore` en `packages/storage`
  (BLOB Float32, escaneo en memoria: unos miles de entradas son unos MB; sin sqlite-vec todavía).
- **Qué sirve:** solo preguntas con ≥`minSeen` (2) respuestas de modelo verificadas (es una pregunta *frecuente*), no expiradas (30 días), del
  mismo idioma, y que pasan **tres** filtros: lista de exclusión (`isCacheable`), coseno ≥0.8 sobre las palabras de contenido y `sameContent`
  (mismas palabras de contenido ± 1 letra y **mismos números**). Esta última es la que impide "capital de Francia" → "capital de Italia".
- **Qué aprende:** solo si el evaluador dio `success` (confianza ≥0.5), ningún intento usó herramientas (ni de solo lectura), sin taint y sin datos
  sensibles. Un fallo del caché nunca falla la tarea.
- Control del usuario por voz/texto, sin modelo: "qué respuestas guardadas tienes", "olvida la respuesta sobre X", "borra todas las respuestas
  guardadas" (pide confirmación), "desactiva/activa las respuestas guardadas" (el interruptor persiste).
- **Medición** (`pnpm --filter @jarvis/harness harness instant-eval`, 15 grupos ES/EN, 776 sondas): 0 falsos positivos en todos los umbrales; 94.7 % de
  paráfrasis acertadas al 0.8 (los 2 fallos: un typo y una pregunta en otro idioma, a propósito). Con modelo real (Groq): 3.ª formulación en 1 ms vs ~500 ms.
- **Lo que NO está probado:** el conjunto de evaluación lo escribí yo mientras ajustaba el guard (riesgo de sobreajuste); no hay datos de uso real.
  El evaluador heurístico no verifica la verdad de una respuesta (7 falsos positivos en 301 celdas del arnés), así que **una respuesta errónea puede
  quedar guardada**; mitigaciones: `minSeen`, TTL, y que el usuario pueda verlas y borrarlas. Idiomas distintos de ES/EN no se clasifican bien.
