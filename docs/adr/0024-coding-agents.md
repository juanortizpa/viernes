# ADR-0024: Agente de programación — Gemini CLI primero, Claude Code después

**Estado:** aceptado · 2026-10-04

## Contexto
El usuario quiere un asistente general **que sirva para programar**, 100 % gratis, con lo que ya tiene: plan gratuito de Gemini (cuenta de Google) y **Claude Pro**. Las suscripciones no dan API; sí dan los CLIs oficiales (**Gemini CLI** y **Claude Code**), que ya saben leer, editar y ejecutar código en una carpeta. Reescribir ese bucle agente sería caro y peor: JARVIS **delega** en ellos y aplica su propia regla "el más barato primero".

## Decisión
- **Paquete `@jarvis/agents`** (independiente del resto): adaptadores `GeminiCliAgent` y `ClaudeCodeAgent` sobre su modo sin interfaz con salida `stream-json`, y `runCodingTask`, la cadena:
  1. **Gemini CLI** (gratis) → 2. **Claude Code** (consume el límite de Claude Pro) solo si el primero **falla, se queda sin cuota o la comprobación del proyecto falla**. El segundo recibe qué intentó el primero y por qué falló.
- **El evaluador es el proyecto, no el modelo:** cada proyecto puede tener `verify` (p. ej. `pnpm test`); "terminé" sin que la comprobación pase cuenta como fallo y escala. Se ejecuta **incluso si el agente fue cortado** por inactividad (el trabajo pudo quedar hecho).
- **Progreso real:** cada uso de herramienta del agente (`tool_use` en el stream) se traduce a una etapa en español ("Gemini: Editando app.js", "Comprobando con «pnpm test»") y sale como evento `progress` del orquestador. Nada inventado.
- **Herramienta `code.agent`** en el sidecar: `{ task, project? }`, **riesgo `sensitive`** (el policy engine pide permiso **cada vez**), salida con procedencia **`untrusted_external`** (la escribió un modelo influido por el contenido del repositorio: lo sensible que venga después en la misma tarea exige confirmación, ADR-0005). Cancelable desde la isla (la señal llega al proceso).
- **Orden directa sin LLM:** "en el proyecto X, …" (o "dentro del / sobre el proyecto X") va directo a `code.agent` conservando **tus palabras** (no la versión normalizada). Por voz se lee en voz alta el resumen del agente.
- **Proyectos por alias** en `jarvis.config.json → coding.projects` (`{ "web": { "path": "D:/web", "verify": "npm test" } }`); alias desconocido o carpeta inexistente → se rechaza, nunca se adivina una ruta. Sin proyecto → carpeta de trabajo temporal (scripts sueltos). `setup` siembra el propio JARVIS como proyecto y conserva tu lista al re-ejecutarse.

## Seguridad (decisiones concretas)
- **La tarea va por stdin, nunca por argumentos:** en Windows los `.cmd` de npm se ejecutan vía `cmd.exe`, donde un texto con `&`, `|` o `"` sería inyección de comandos. Los argumentos son fijos; si la ruta del binario tiene caracteres peligrosos se rechaza.
- **Permisos de los agentes acotados:** Gemini `--approval-mode auto_edit`, Claude `--permission-mode acceptEdits`: pueden editar archivos del proyecto; para comandos se apoyan en sus propias reglas. El prompt prohíbe commits, push e instalaciones globales. (`yolo`/`bypassPermissions` existen en la config pero no son el valor por defecto.)
- **Límites de tiempo:** total (15 min) e inactividad (3 min sin salida). Al cortar se mata **el árbol de procesos** completo (`taskkill /T /F` en Windows, grupo de procesos en POSIX).

## Hallazgos medidos (Gemini CLI 0.62 real)
- En modo sin interfaz **se niega a trabajar en carpetas no marcadas como confiables**: se pasa `GEMINI_CLI_TRUST_WORKSPACE=true` solo a ese proceso (la carpeta ya la eligió el usuario como proyecto).
- Ante errores 503 del servidor **reintenta sin emitir nada durante minutos** → de ahí el corte por inactividad + comprobación posterior.
- Prueba real: arreglar un bug de suma en un proyecto pequeño → **91 s**, comprobación `node test.js` OK, **sin escalar** a Claude.

## NO verificado / límites
- **Claude Code real no se probó** (no hay sesión de Claude Pro en el entorno de desarrollo); el adaptador se probó con un CLI falso que emite los mismos eventos documentados.
- **No probado en Windows** (shims `.cmd`, `taskkill`). Los tests cubren el plan de ejecución de Windows, no su ejecución.
- Las cuotas gratuitas de Gemini CLI cambian; al agotarse se detecta (`429`/"quota") y se pasa a Claude.
- Tareas largas (>15 min) se cortan; ajustable con `coding.timeoutMs`.
