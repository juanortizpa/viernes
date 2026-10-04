# ADR-0012: Evaluadores y cascada con escalado seguro

**Estado:** aceptado · 2026-10-04

## Contexto
Con ADR-0011 el router elige un modelo antes de ejecutar. Falta saber si la respuesta sirvió y, si no, subir al siguiente
modelo. Restricción del proyecto por ahora: **todo debe ser gratis** (modelos `:free` de OpenRouter, Ollama local); no se
añade ningún proveedor ni modelo de pago ni juez LLM de pago.

## Decisión
- **`Evaluator`** (core): `evaluate(input) → Verdict | undefined` (undefined = no aplica). `runEvaluators` combina: gana el peor
  resultado, la confianza es el mínimo, y los costos de evaluador (`verdict.usage`) se suman a `totalCostUsd`.
- **Evaluadores incluidos, todos gratuitos y deterministas:**
  - `ResponseHeuristicEvaluator`: respuesta vacía o con repetición degenerada ⇒ `failure`; aspecto de rechazo, respuesta demasiado
    corta o tarea de código sin código ⇒ `uncertain`; el resto ⇒ `success` con confianza 0.6. Puede probar que algo está roto, nunca
    que es correcto.
  - `CodeTestsEvaluator`: ejecuta el primer bloque de código con un `CodeTestRunner` inyectado. **No hay runner en el sidecar en vivo:**
    ejecutar código generado por un modelo exige sandbox (lo aporta el arnés de la Fase 3).
  - Postcondición de herramienta: ya existía dentro de `invokeTool`; ahora usa `toolPostconditionVerdict`.
  - **Juez LLM: no implementado** (necesita calibración contra etiquetas humanas, Fase 6, y no hay modelo gratuito fiable para ello).
- **Cascada** (`maxEscalations`, por defecto 1 en el sidecar; 0 la desactiva): si el veredicto es `failure`, o `uncertain` con confianza
  < 0.7 (`shouldEscalate`), se reintenta con el siguiente modelo elegible más caro. Con precios iguales (todo gratis) manda el orden de
  la config: **debe ir de más débil a más fuerte**. Cada intento queda en la traza con su veredicto y decisión (`cascade_v1`) y emite
  `escalated`. La baseline premium se calcula sobre el último intento.
- **Escalado seguro (checkpoint mínimo):** si en el intento corrió una herramienta de riesgo mayor que `read`, no se escala, porque se
  repetirían efectos secundarios; el resultado se entrega o falla tal cual. Snapshots/dry-run/plan→aprobación quedan para después.
- **Errores del proveedor** (p. ej. límite de tasa de un modelo gratuito) cuentan como intento fallido y escalan; si no hay a dónde
  escalar, se relanza el error como antes.
- **Taint** abarca toda la tarea, incluidos todos los intentos.
- **`freeOnly`** (config, por defecto `false`): el sidecar no arranca si algún modelo tiene precio. `jarvis.config.free.example.json`
  lo activa y trae tres modelos gratuitos de OpenRouter ordenados de menor a mayor.

## Consecuencias
+ Se puede medir calidad/costo/escalado sin gastar. + Un modelo gratuito caído o limitado ya no tumba la tarea.
− Las heurísticas son burdas: una respuesta incorrecta pero bien formada pasa. − Los modelos gratuitos tienen límites de tasa y cambian
con el tiempo; la lista del ejemplo hay que revisarla. − Un rechazo legítimo de contenido dañino también escala una vez.
