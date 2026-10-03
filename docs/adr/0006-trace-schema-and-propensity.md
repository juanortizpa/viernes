# ADR-0006: Esquema de traza con `propensity` para evaluación off-policy

**Estado:** aceptado · 2026-10-03

## Contexto
Si el router solo prueba un modelo más fuerte tras un fallo, nunca se aprende si ese modelo habría
funcionado barato: los datos están sesgados por la propia política. Además, el experimento necesita
reproducir decisiones sin volver a llamar a las APIs.

## Decisión
- Toda `RoutingDecision` registra `propensity` (probabilidad que la política asignó a la acción elegida),
  `explored`, candidatos con puntaje y racional.
- `ExecutionTrace` guarda intentos, veredictos, uso, escalados, intervención del usuario y costo total
  **incluyendo el costo del evaluador**.
- `baselineCostUsd` guarda el costo de la línea base definida (siempre-premium sobre la misma tarea),
  de modo que el "ahorro" nunca sea un número hipotético sin definición.
- El experimento usará además una **tabla contrafactual** (cada modelo × cada tarea, una vez) para
  simular routers offline.

## Consecuencias
+ Permite evaluación off-policy y comparación justa. − Obliga a una pequeña exploración controlada.
