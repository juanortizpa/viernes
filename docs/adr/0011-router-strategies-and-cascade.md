# ADR-0011: Estrategias de router, filtrado por capacidades y cascada vs ruteo predictivo

**Estado:** aceptado (primer corte de Fase 2) · 2026-10-04

## Contexto
Fase 1 usaba `StaticRouter`. La tesis del proyecto es decidir qué modelo usar por tarea, y para evaluarla hacen falta
varias estrategias intercambiables, un baseline definido y trazas que permitan repetir las decisiones offline (ADR-0006).

## Decisión
- **Restricciones duras antes que estrategia** (`filterCandidates`): herramientas, visión, ventana de contexto y
  sensibilidad de datos (dato sensible ⇒ solo modelos locales). Una estrategia solo elige entre modelos elegibles; si no hay
  ninguno la tarea falla con el motivo de cada rechazo, nunca degrada en silencio. Los rechazos quedan en `decision.candidates`.
- **Estrategias deterministas** tras la interfaz `ModelRouter`: `always_premium`, `always_cheapest`, `rules_v1` (barato para
  trabajo fácil; premium si el tipo es coding/debugging/agentic o la complejidad ≥ 0.6) y `static_v0`. `propensity = 1`.
  Se elige en la config (`router`); el valor por defecto sigue siendo `static`.
- **Clasificador de tarea por reglas** (`classifyTask`, ES/EN, sin LLM): tipo + complejidad heurística. Sustituye la constante 0.5.
  Es una estimación burda a propósito: el router aprendido (Fase 6) usará la misma interfaz con mejores señales.
- **"Premium"** = mayor precio combinado (entrada + salida por 1M tokens) de la hoja de capacidades; los precios son estimaciones del usuario.
- **Baseline definido:** cada traza guarda `baselineCostUsd` = lo que habría costado la misma cantidad de tokens en el modelo premium
  configurado, para medir ahorro contra una referencia fija.

## Cascada vs ruteo predictivo
- **Cascada** (barato → evaluar → escalar): robusta y simple de razonar, pero paga dos veces cuando escala y necesita un evaluador
  fiable; sin evaluador no hay cascada. Por eso queda **después** de implementar los evaluadores (siguiente corte de Fase 2).
- **Ruteo predictivo** (elegir antes de ejecutar): una sola llamada, pero depende de predecir la dificultad; un clasificador malo
  cuesta calidad sin enterarse. Se evaluará en Fase 3/6 contra el oráculo del arnés contrafactual.
- **Decisión provisional:** reglas deterministas hoy; cascada con evaluador como siguiente paso; el predictivo/bandit solo cuando el
  arnés pueda compararlo con datos. No se elige "ganador" sin esos datos.

## Consecuencias
+ Estrategias comparables con el mismo contrato y trazas reproducibles. + Los límites duros no dependen de ninguna heurística.
− La clasificación por reglas se equivocará (p. ej. coding sin palabras clave) y no hay detección automática de datos sensibles aún:
`sensitive` existe en el contrato pero nadie lo activa todavía.
