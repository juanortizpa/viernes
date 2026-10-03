# ADR-0004: `OrchestratorEvent` como flujo único para UI y telemetría

**Estado:** aceptado · 2026-10-03

## Contexto
El producto exige "nunca progreso falso" y el experimento exige trazas completas. Dos canales separados
terminarían divergiendo.

## Decisión
El orquestador emite una única secuencia de `OrchestratorEvent` (unión discriminada validada con zod).
- La **UI** deriva todo su estado de esos eventos mediante un reducer puro (`islandReducer`).
- La **telemetría** se construye consumiendo los mismos eventos (`ExecutionTrace`).
- El campo `progress.fraction` es opcional: sin dato real, no se muestra barra.
- `progress.stage` debe describir trabajo ya hecho. Un acuse inmediato ("voy a revisarlo") es una
  recepción, no un hallazgo, y no usa `progress`.

## Demo
Hasta la Fase 1, `DemoPlayer` reproduce escenarios guionados validados contra el mismo esquema y la UI
los etiqueta "DEMO". Cuando exista el orquestador, solo cambia la fuente de eventos.

## Consecuencias
+ La UI no puede mostrar algo que no ocurrió. + Replays y tests deterministas.
− Todo cambio de comportamiento visible requiere un evento en el protocolo.
