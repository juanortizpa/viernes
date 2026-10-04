# ADR-0025: Cliente MCP — cualquier servidor MCP como herramientas de JARVIS

**Estado:** aceptado · 2026-10-04 · barrida de funcionalidades

## Contexto
Lo que hace extensible a Claude Code (y a cualquier agente serio) es MCP: GitHub, navegador, bases de datos, Notion, etc. sin
escribir un adaptador por servicio. En JARVIS, MCP figuraba como «adaptador en el borde» desde el ADR-0001, pero no existía.

## Decisión
- **Paquete `@jarvis/mcp`**, sin dependencias externas: cliente JSON-RPC 2.0 propio sobre **stdio** (mensajes por línea),
  `initialize` → `notifications/initialized` → `tools/list` (paginado) → `tools/call`, timeouts y cancelación
  (`notifications/cancelled`). Versiones aceptadas: 2025-06-18, 2025-03-26, 2024-11-05.
- **El cliente no ofrece capacidades** (ni `sampling`, ni `roots`, ni `elicitation`): un servidor no puede hacer que JARVIS llame a
  un modelo ni enterarse de carpetas. Pedidos del servidor: `ping` se responde; el resto, «method not found».
- **Las herramientas MCP pasan por el mismo `invokeTool`** que todas (validación, policy engine, permiso, taint). Nombre
  `mcp.<servidor>.<herramienta>` saneado para las APIs de modelos (≤ 56 caracteres, sin colisiones).
- **Riesgo lo decide el usuario, no el servidor:** por defecto `sensitive` (pregunta antes de cada llamada); `readOnlyTools` baja
  herramientas concretas a `read`. Las anotaciones del servidor (`readOnlyHint`) **se ignoran**: un servidor puede mentir.
- **Todo lo que devuelve un servidor es `untrusted_external`**, también el texto de sus errores JSON-RPC.
- **Entorno mínimo:** los servidores reciben PATH/perfil/temporales y lo que declares en `env`; **nunca** las claves de JARVIS
  (Groq, Gemini, OpenRouter). `"$NOMBRE"` en `env` se lee de `jarvis.env`, así los secretos no viven en el JSON. Una variable
  que falta es un error, no un string vacío.
- **Arranque en segundo plano:** el sidecar queda listo enseguida; los servidores se conectan en paralelo (90 s de margen para la
  primera descarga de `npx`/`uvx`) y sus herramientas se registran al llegar (el orquestador relee el registro en cada intento).
  Un servidor que falla se informa y se salta; nunca impide arrancar. Al cerrar se mata el árbol de procesos.
- En Windows, `npx` es un `.cmd`: se lanza con el mismo `planSpawn` de los agentes (cmd.exe con argumentos fijos y verificados).

Configuración (`jarvis.config.json`):
```json
"mcp": { "servers": {
  "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
              "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN" }, "readOnlyTools": ["search_repositories", "get_issue"] }
} }
```

## Verificado
- Tests contra un servidor real por stdio (proceso hijo): handshake, paginación, `ping` y `sampling` del servidor, timeout,
  cancelación, servidor que muere con llamadas pendientes, versión no soportada, nombres, riesgo, entorno sin claves.
- **Contra el SDK oficial de MCP 1.30.1** (servidor de referencia escrito con `McpServer`): esquemas, `isError`, errores de
  validación `-32602`. Y de punta a punta con un modelo real (Groq gpt-oss-120b): eligió `mcp.calc.add` y respondió «10 000».

## No hecho / límites
- Transporte HTTP (Streamable HTTP/SSE), recursos y prompts de MCP: V2.
- `notifications/tools/list_changed` se registra en el log; la lista nueva se aplica al reiniciar.
- Sin UI para gestionar servidores: se editan en la config; «¿qué podés hacer?» muestra cuáles conectaron y por qué no los otros.
