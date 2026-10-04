# ADR-0014: Groq y Google AI Studio como proveedores; `tier` para ordenar modelos del mismo precio

**Estado:** aceptado · 2026-10-04

## Contexto
OpenRouter gratis permite 50 peticiones/día, lo que frena el experimento (ADR-0013) y el uso diario. Groq (open-weight,
muy rápido) y Google AI Studio (Gemini) ofrecen cuotas gratuitas más amplias, por modelo y por cuenta.

## Decisión
- **Groq** = `OpenAICompatibleProvider` (el adaptador de OpenRouter, generalizado). Lee el uso también de `x_groq.usage`.
- **Google** = adaptador propio (`GoogleProvider`, `streamGenerateContent`). Particularidades que maneja y que tienen test:
  esquemas de herramientas reducidos al subconjunto de Gemini (sin `additionalProperties`/`$schema`; sin `parameters` si
  la herramienta no tiene argumentos); resultados de herramientas como `functionResponse` en un solo turno de usuario;
  `thoughtSignature` devuelta con cada `functionCall` (campo opaco `ToolCall.providerData`); los resúmenes de
  pensamiento no se muestran y los tokens de pensamiento se cobran como salida.
- Claves: `GROQ_API_KEY`, `GEMINI_API_KEY` (o `GOOGLE_API_KEY`). Secciones `groq` y `google` en la config del sidecar y del arnés.
- **`ModelCapabilities.tier`** (opcional, mayor = más fuerte): desempata modelos de **igual precio**. Sin él, en una
  config multi-proveedor toda gratis la escalera seguiría el orden de registro (ollama, anthropic, openrouter, groq, google),
  no la fuerza. El precio manda siempre sobre el tier; sin tier ni precio distinto, manda el orden de la config.
- La cuota diaria de Groq (RPD/TPD) y la de Google (`...PerDay...`) detienen la corrida del arnés igual que la de OpenRouter.
- `harness list-models --provider groq|google` lista los modelos que la clave puede usar; los configs se escriben a partir
  de eso, no de memoria.

## Lo que NO está validado
- Los adaptadores Groq y Google se probaron solo con `fetch` simulado (como OpenRouter antes de la prueba real). Hacen falta
  claves para validarlos en vivo; la prueba de OpenRouter mostró que esos tests no detectan restricciones del servidor
  (p. ej. nombres de función con punto).
- Los IDs de Groq de `jarvis.config.free-multi.example.json` salen de memoria: verificar con `list-models`.
- Los modelos "Live" de Gemini (audio/tiempo real, cuota ilimitada) usan otra API (WebSocket) y **no** sirven para este
  adaptador; son relevantes para la voz (Fase 7), no para texto.
- Los datos enviados al tier gratuito de Google pueden usarse para mejorar sus productos: el guard de datos sensibles
  ya los trata como no locales, pero conviene no ponerlos en tareas con información privada.

## Consecuencias
+ Más cuota y modelos rápidos para el arnés y la cascada. + Un `tier` explícito evita escaleras mal ordenadas.
− `tier` es un juicio manual que hay que mantener. − Un adaptador más con su propio dialecto de herramientas.
