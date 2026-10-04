# ADR-0008: IPC del sidecar (NDJSON sobre stdio) y puente solo-dev en Vite

**Estado:** aceptado · 2026-10-04 (concreta ADR-0002)

## Contexto
ADR-0002 fija un sidecar TypeScript con IPC local autenticado y sin puertos de red. La demo corre en un
navegador (Vite, Codespaces), que no puede hablar por stdio.

## Decisión
- **Protocolo** (`packages/ipc`): mensajes zod `ClientMessage` / `ServerMessage`, un JSON por línea (NDJSON),
  versión `IPC_VERSION = 1`. Es isomórfico: lo usan el sidecar, el puente y la UI.
- **Sidecar** (`apps/sidecar`): proceso Node que lee/escribe el protocolo por stdin/stdout; logs solo por stderr.
  No abre ningún puerto. `SidecarServer` es independiente del transporte y recibe líneas.
- **Autenticación:** el host entrega `JARVIS_TOKEN` por entorno; el primer mensaje debe ser `hello` con ese
  token (comparación en tiempo constante). Handshake inválido = `hello.error` y salida con código 3.
- **Permisos:** `permission.required` viaja como evento; la respuesta llega como `permission.answer`. Sin
  respuesta en 120 s se **deniega**. Cancelar o desconectar deniega lo pendiente y cancela las tareas.
- **Configuración honesta:** sin proveedor configurado el sidecar usa `offline-echo`, que se anuncia en
  `hello.ok` (`offline: true`) y la UI lo muestra. Precios y latencias vienen de `jarvis.config.json`
  (el usuario las declara); nunca se inventan. Las claves de API solo se leen del entorno.
- **Puente solo-dev** (`apps/desktop/vite-plugin-jarvis.ts`, `apply: "serve"`): lanza un sidecar por conexión
  WebSocket en `/__jarvis/ws` del servidor de Vite y reenvía líneas. El token se sirve en `/__jarvis/token`
  solo same-origin (sin cabeceras CORS; 403 si `Sec-Fetch-Site: cross-site`). El puerto es el de Vite,
  no del sidecar. En producción lo reemplaza el shell Tauri (spawn del sidecar + relevo de stdio).

## Alternativas descartadas
- WebSocket/HTTP directo en el sidecar: abre un puerto local atacable (otras webs, otros procesos).
- Named pipe desde el primer día: más difícil de probar en Linux/Codespaces; stdio cubre el mismo modelo.

## Consecuencias
+ El mismo `SidecarServer` sirve a cualquier transporte; la demo usa el sidecar real.
− Un sidecar por pestaña en desarrollo (~0,5 s de arranque). − El relevo Tauri sigue sin escribir ni probar (requiere Windows).
