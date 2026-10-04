# ADR-0009: Bucle de herramientas propuesto por el LLM

**Estado:** aceptado · 2026-10-04

## Contexto
Hasta ahora solo los intents locales ejecutaban herramientas. Para que el modelo las use, el LLM *propone*
y el sistema *decide* (ADR-0005), y el taint tracking tiene que activarse con contenido real no confiable.

## Decisión
- **Un único camino de ejecución.** `Orchestrator.invokeTool` sirve tanto al intent local como a las llamadas del
  modelo: validar argumentos con zod → policy engine determinista → confirmación del usuario si se exige →
  ejecutar → registrar `provenance` en el taint → verificar postcondición. El modelo no puede saltarse ningún paso.
- **Bucle acotado:** `MAX_TOOL_STEPS = 5` llamadas al modelo por tarea; al agotarlo la tarea falla de forma explícita.
- **Errores al modelo, no a la tarea:** herramienta desconocida, argumentos inválidos (incluido JSON malformado),
  permiso denegado o fallo de la herramienta vuelven al modelo como resultado de la herramienta; puede corregirse o explicar.
- **Taint a nivel de tarea:** una vez que entra contenido `untrusted_external` (p. ej. `files.read`), toda acción
  `sensitive` posterior exige confirmación, incluso si estaba preaprobada en `allowSensitive`.
- **Salida no confiable acotada:** se envía al modelo dentro de `<untrusted_external_content>` y truncada a 20 000
  caracteres, con una instrucción de sistema de tratarla como datos. Esto es una mitigación, **no** la garantía:
  la garantía es el policy engine.
- **Telemetría:** cada llamada al modelo emite su `model.completed` (la UI suma coste y tokens); la traza agrega los
  pasos en un solo `Attempt`, porque un paso de herramienta no es un escalado.
- **Capacidad por adaptador:** `Provider.supportsToolCalls` indica qué sabe hacer el adaptador y
  `ModelCapabilities.supportsTools` qué sabe hacer el modelo. Solo se ofrecen herramientas si ambos son verdaderos.
  Anthropic y Ollama aún no las implementan y rechazan `tools` con un error explícito en lugar de ignorarlas.
- **Nombres de herramienta en el cable:** las APIs estilo OpenAI exigen `[a-zA-Z0-9_-]`; el registro usa `files.read`.
  El adaptador codifica `.`→`__` al enviar y decodifica con los nombres ofrecidos en la petición.
- **Estado de tarea:** se permite `running → awaiting_permission`, porque una confirmación puede aparecer a mitad del bucle.

## Consecuencias
+ Una sola superficie que auditar para la seguridad de las herramientas. + Los errores se recuperan sin reiniciar la tarea.
− Anthropic y Ollama quedan sin herramientas hasta implementarlas. − La mitigación de inyección por etiquetado depende
del modelo; por eso la barrera real sigue siendo determinista.
