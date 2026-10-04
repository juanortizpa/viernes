# ADR-0003: Abstracción de proveedores y `ModelCapabilities`

**Estado:** aceptado · 2026-10-03

## Decisión
Cada proveedor es un adaptador que implementa una interfaz común y expone `ModelCapabilities`
(visión, herramientas, streaming, contexto, costo de entrada/salida, latencia esperada, `isLocal`,
`qualityPrior` opcional). El router decide **solo** con esos metadatos más el historial.

Proveedores del MVP: Anthropic, OpenRouter y Ollama (tres, para demostrar que la abstracción no depende
de un proveedor). OpenAI y Google entran después sin cambios en orquestador ni router.

## Reglas
- Prohibida lógica específica de proveedor dentro del router.
- Los costos se expresan en USD por millón de tokens y se tratan como estimaciones.
- `isLocal` permite restricciones de sensibilidad de datos (p. ej. contenido privado solo a modelos locales).

## Consecuencias
+ Nuevo proveedor = un adaptador. − Hay que normalizar uso, errores y tool-calls entre proveedores.
