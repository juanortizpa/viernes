# ADR-0027: Rutinas deterministas y «¿qué podés hacer?»

**Estado:** aceptado · 2026-10-04 · barrida de funcionalidades

## Contexto
Para el uso diario de un asistente personal, lo repetitivo («abrí VS Code, Teams y el navegador») no debería costar un modelo ni
depender de que este interprete bien. Y el usuario no tenía forma de saber qué está conectado (apps, proyectos, MCP, web, voz).

## Decisión
- **Rutinas** en `jarvis.config.json → routines`: nombre → frases que el usuario diría él mismo
  (`"modo trabajo": ["abre vs code", "abre teams", "en el proyecto web, corré los tests"]`). Se disparan con el nombre solo o con
  «activá / ejecutá / iniciá (la rutina) …».
- **Cada paso se resuelve con el router determinista** (el mismo de las órdenes escritas, sin rutinas para evitar recursión) y
  **nunca con un modelo**. Un paso que necesitaría modelo o que solo se reconoce «con dudas» invalida la rutina entera: se explica
  por qué y no se ejecuta la mitad. Los problemas se avisan también al arrancar el sidecar.
- **Cada paso pasa por `invokeTool`** (policy engine y permisos por paso: un paso sensible pregunta). Un paso que falla o se deniega
  se informa y los demás siguen; la tarea solo cuenta como éxito si salieron todos. Progreso real: «Rutina «X»: paso 2 de 3».
- Contrato: `Intent.sequence = { name, steps: RoutineStep[] }` en `@jarvis/core`; el orquestador lo ejecuta en `runSequence`.
- **«¿Qué podés hacer?» / «ayuda» / «qué rutinas tengo»** → `assistant.capabilities`, local y gratis, construido desde la
  configuración viva: modelos, apps conocidas, agentes de programación instalados, proyectos, rutinas, servidores MCP (con el
  motivo de los que no conectaron), web, voz y memoria. No lista nada que no esté cableado.

## Verificado
Tests por el runtime: tres formas de disparo, 0 llamadas a modelo, progreso por paso, rutina inválida rechazada entera (y avisada al
arrancar), paso sensible denegado mientras los demás corren, una rutina no captura otras órdenes. Prueba de humo con el bundle real.

## Límites
- Sin parámetros («modo trabajo en el proyecto X»), sin condicionales ni esperas entre pasos: si hace falta, V2.
- Se editan en el JSON; no hay editor en la isla.
