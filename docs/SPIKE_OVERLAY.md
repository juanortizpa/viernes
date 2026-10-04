# Spike: overlay de la isla en Windows (Fase 0)

**Estado:** esqueleto escrito, **sin validar**. El entorno de desarrollo es Linux; esto requiere una
máquina Windows 10/11. El código está en `apps/desktop/src-tauri/` y no se ha compilado.

## Cómo correrlo (Windows)

Requisitos: Rust (MSVC), WebView2 (viene con Windows 11), Node 22, pnpm.

```powershell
pnpm install
cd apps/desktop
pnpm tauri dev
```

(Puede hacer falta `pnpm add -D @tauri-apps/cli` en `apps/desktop` y generar iconos con
`pnpm tauri icon`.)

## Qué hay que comprobar

| # | Prueba | Resultado |
|---|---|---|
| 1 | La ventana es realmente transparente (se ve el escritorio detrás de la isla, el glass se nota) | ☐ |
| 2 | Siempre encima de ventanas normales | ☐ |
| 3 | Sin decoración, sin barra de tareas, sin robar el foco al aparecer | ☐ |
| 4 | **Clics en zonas transparentes pasan a la app de abajo** (el punto crítico) | ☐ |
| 5 | Visible sobre apps en pantalla completa (video, IDE) y sobre juegos (borderless / exclusivo) | ☐ |
| 6 | DPI 100/125/150 % y dos monitores con escalas distintas | ☐ |
| 7 | Animaciones fluidas (sin parpadeo, <5 % CPU en reposo) | ☐ |
| 8 | Consumo de RAM en reposo | ☐ MB |

## Cómo decidir

- Si 1–4 pasan: seguir con Tauri.
- Si 4 falla (el clic-through por píxel no se puede resolver con `set_ignore_cursor_events` +
  regiones de hit-test): probar Electron (`setIgnoreMouseEvents(true, { forward: true })`) y
  registrar un ADR con la comparación.
- Si 5 falla solo con juegos en pantalla completa exclusiva: documentarlo como limitación
  conocida; no es bloqueante para el MVP.

## Notas de diseño

- El comando `set_click_through` existe para alternar el modo. El plan es: la ventana ignora el ratón
  por defecto y la UI la activa cuando el cursor entra al rectángulo de la isla.
- La ventana mide 420×240 y la isla se dibuja dentro; el resto es transparente.
- Dentro de Tauri, el frontend detecta `__TAURI_INTERNALS__` y muestra solo la isla (sin el panel de demo).

## Pruebas adicionales de Fase 4 y voz (Windows)

| # | Prueba | Resultado |
|---|---|---|
| 9 | Permiso de micrófono en WebView2: aparece una vez, se recuerda, y el indicador de Windows se apaga al soltar el botón | ☐ |
| 10 | Atajo global de push-to-talk con la isla sin foco (hay que añadirlo en Tauri) | ☐ |
| 11 | Panel AI Economy abre/cierra con clic sin robar clics a la app de abajo (hit-test) | ☐ |
| 12 | Permiso: `Esc` deniega aunque el foco esté en otra app (hoy solo con la ventana enfocada) | ☐ |
| 13 | Isla visible y sin recortes con un monitor a 100 % y otro a 150 % al arrastrarla entre ambos | ☐ |
| 14 | Con "Reducir animaciones" de Windows activado el cuervo no tiene bucles | ☐ |
| 15 | whisper.cpp real: frase en español y en inglés → precisión y latencia con tiny/base/small | ☐ |

Config de ejemplo para la voz: `jarvis.config.voice.example.json` (binario y modelo de whisper.cpp que pones tú).
