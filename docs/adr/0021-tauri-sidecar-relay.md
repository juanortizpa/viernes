# ADR-0021: Relevo del sidecar en el shell Tauri (la isla habla con el núcleo real)

**Estado:** aceptado · 2026-10-04 (concreta ADR-0002 y ADR-0008; reemplaza al puente de Vite dentro de Tauri)

## Contexto
Hasta ahora todo lo real (órdenes, voz, economía, permisos) solo funcionaba en el navegador con `start.bat`, a través del puente
solo-dev de Vite. La ventana Tauri (la isla flotante, siempre encima) no arrancaba el sidecar: mostraba una isla inerte. Sin este
relevo JARVIS no puede ser una isla siempre visible.

## Decisión
- **El shell lanza el sidecar** (`src-tauri/src/sidecar.rs`): `node sidecar.mjs` con `JARVIS_TOKEN` aleatorio (24 bytes del SO) y el
  resto del entorno heredado (claves, `JARVIS_CONFIG`, `JARVIS_DATA_DIR`). stdio por tuberías, **sin puertos**. En Windows,
  `CREATE_NO_WINDOW` (no aparece una consola detrás de la isla). Rust **no interpreta** el protocolo: reenvía líneas.
- **Comandos** (solo para la ventana `island`, por capability): `sidecar_token`, `sidecar_start(onMessage: Channel)` → `generation`,
  `sidecar_send(generation, line)`, `sidecar_stop(generation)`. Las líneas de stdout y la salida del proceso (`{kind:"exit",code}`)
  llegan por un `Channel` de Tauri, que conserva el orden.
- **Un sidecar por conexión**, como el puente: reiniciar (recarga de la vista, botón Reintentar) mata el anterior. Cada arranque tiene
  una **generación**; un envío o una parada con una generación vieja no hace nada, así un proceso viejo nunca toca al nuevo.
- **Mismo protocolo, mismo cliente:** la UI usa `LiveClient` sin cambios de protocolo; `tauriTransport()` adapta los comandos a
  `SocketLike`. El handshake con token lo sigue comprobando el sidecar. Los envíos se encadenan en JS porque los comandos async de
  Tauri pueden ejecutarse en paralelo y las líneas del protocolo deben conservar su orden.
- **Ciclo de vida:** al salir la app se cierra stdin (el sidecar cierra SQLite y sale con 0); si no sale en 2 s se mata. Si el
  shell muere de golpe, la tubería se cierra y el sidecar sale solo (verificado con `kill`). stderr va a la consola y a
  `.jarvis/sidecar.log` (se trunca al pasar de 5 MB).
- **Dónde está el sidecar:** `JARVIS_SIDECAR` > `sidecar.mjs` junto al ejecutable > (solo builds debug) el bundle del repo.
  Node: `JARVIS_NODE` o `node` del PATH. Si falta, la isla muestra cómo arreglarlo (no se queda colgada).
- **Arranque para el usuario:** `island.bat` → `scripts/island.mjs`: mismo entorno que `start.bat` (`jarvis.env`, `.jarvis`,
  `jarvis.config.json`), empaqueta el sidecar, compila la isla en release **solo si el código cambió** y la deja corriendo sin consola.
  `--dev` usa `tauri dev` (Vite en 127.0.0.1 con el puente **desactivado**: dentro de Tauri el relevo es el shell).
- **UI en la isla:** debajo del cuervo, un dock compacto (orden escrita, push-to-talk, manos libres) que se atenúa si no está el
  puntero; si el sidecar no está, el dock dice por qué y ofrece Reintentar. Ajustes extensos (registro de voz, modo de habla,
  calibración) siguen en el panel del navegador.
- **La ventana mide lo que la isla:** `WindowFitter` ajusta la altura (crece al instante, encoge tras 450 ms, pasos de 32 px) con
  `core:window:allow-set-size`. Nada se recorta y la zona transparente que tapa clics a las apps de abajo es mínima.

## Alternativas descartadas
- Rust hace el handshake y la UI nunca ve el token: más lógica en Rust para nada; el token protege el canal frente a otros procesos,
  y aquí el canal es una tubería privada del shell.
- Mantener Vite + puente dentro de Tauri: deja un servidor HTTP local que ejecuta órdenes; justo lo que ADR-0002 quiere evitar.
- `tauri-plugin-shell` con `externalBin`: exige un binario por plataforma (Node SEA, aún pendiente) y amplía la superficie de permisos.

## Verificado (Linux, WebKitGTK sobre Xvfb, build release real)
- La isla hace el handshake con el sidecar real: «que hora es» (local, 0 tokens), «hola» (respuesta inmediata) y una pregunta al
  modelo con **cascada real** (OpenRouter 429 → Groq `gpt-oss-20b`) se ven en la isla, con tokens y escalado.
- Matar el sidecar → la isla dice «Sidecar no disponible… terminó» → Reintentar arranca otro y responde. Recargar la vista reemplaza
  el sidecar (nunca quedan dos). Cerrar el shell de golpe no deja sidecars huérfanos.
- `tauri dev` vía `island.mjs --dev`: Vite en 127.0.0.1 y `/__jarvis/token` ya no existe.
- Simulación en Chromium (permisos reales del policy engine dentro de la vista Tauri) y altura pedida por `WindowFitter`.
- Tests: transporte Tauri (orden de envíos, errores del shell, código de salida, reintento con proceso viejo, cierre durante el
  arranque), `WindowFitter`, resolución de rutas en Rust (`cargo test`), chequeo de recompilación del lanzador.

## NO verificado (requiere Windows)
- Compilar y ejecutar en Windows (MSVC + WebView2), `CREATE_NO_WINDOW`, y la tabla del overlay de `docs/SPIKE_OVERLAY.md`
  (transparencia real, clic que atraviesa, pantalla completa, DPI, multi-monitor).
- Micrófono dentro de WebView2 (permiso, indicador) y voz en la isla. En Linux/Xvfb no hay micrófono: la isla lo dice.
- En WebKitGTK la ventana no baja de 200 px de alto (mínimo de la plataforma); en Windows se espera que siga a la isla.

## Consecuencias
+ La isla es la app: real, sin navegador ni servidor HTTP. + El núcleo y la UI no cambiaron de protocolo.
− Hace falta Rust para compilar la isla (una vez; luego `island.bat` arranca en ~1 s). − Sigue dependiendo de un Node instalado
  (binario autocontenido: pendiente). − El atajo global de push-to-talk sigue pendiente: con la isla sin foco, Ctrl+Espacio no llega.
