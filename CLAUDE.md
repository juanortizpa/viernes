# JARVIS

Antes de trabajar, lee:

1. `docs/PROJECT_CONTEXT.md` — visión, arquitectura, reglas duras, decisiones vigentes.
2. `docs/ROADMAP.md` — fase actual, checklist y preguntas abiertas.
3. `docs/adr/` — decisiones técnicas ya tomadas.

Reglas rápidas:
- Responder en español; código e identificadores en inglés.
- Contratos primero, implementación incremental, archivos pequeños y modulares.
- Cuestionar ideas que añadan complejidad, riesgo, latencia o costo; distinguir MVP / V2 / Investigación.
- Nunca progreso falso en la UI: todo deriva de `OrchestratorEvent`.
- El LLM propone; el policy engine (determinista) decide.
- Al terminar una tarea: actualizar `docs/ROADMAP.md` (checklist y registro de cambios).
- Rama de desarrollo: `claude/zen-hamilton-rk8a2b`. No crear PR salvo que el usuario lo pida.
