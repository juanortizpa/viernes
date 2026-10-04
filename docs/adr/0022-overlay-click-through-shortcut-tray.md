# ADR-0022: Isla como overlay — clic que atraviesa por regiones, atajo global, bandeja e instancia única

**Estado:** aceptado · 2026-10-04 (completa ADR-0021; responde a las pruebas 4, 10 y 11 de `docs/SPIKE_OVERLAY.md`)

## Contexto
Con el sidecar conectado (ADR-0021), a la isla aún le faltaba lo que la hace usable como presencia siempre visible: la zona
transparente tapaba clics a las apps de abajo, hablar exigía enfocar la isla, no había forma de ocultarla o salir (no tiene barra
de título ni botón en la barra de tareas), abrir `island.bat` dos veces creaba dos islas, y los ajustes de voz solo existían en el
panel del navegador.

## Decisión
- **Clic que atraviesa por regiones** (`src-tauri/src/overlay.rs`, `src/shell/hit-regions.ts`): la UI informa los rectángulos
  clicables (isla, dock, ajustes, aviso) cada 100 ms y al pulsar/soltar; un hilo del shell compara cada 40 ms el cursor del SO con
  ellos y alterna `set_ignore_cursor_events`. La UI decide qué es clicable; Rust solo hace la geometría.
  Salvaguardas: sin regiones aún, o si la plataforma no da la posición del cursor, la ventana **siempre** acepta el ratón (nunca
  queda inalcanzable); con un botón pulsado dentro de la UI (`hold`, p. ej. push-to-talk) mantiene el ratón aunque el cursor salga.
  `JARVIS_CLICK_THROUGH=0` lo desactiva para depurar el spike.
- **Atajo global de push-to-talk: `Ctrl+Alt+Espacio`** (`tauri-plugin-global-shortcut`). No `Ctrl+Espacio`: lo usan VS Code
  (autocompletar) y los IME. Pulsado/soltado llegan a la isla como eventos `jarvis://ptt` y mueven **el mismo código** de micrófono
  que el botón (el micrófono sigue abierto solo mientras se mantiene). Pulsarlo con la isla oculta la muestra. Si otra app tiene
  la combinación, el shell lo informa (`shell_info`) y los ajustes lo dicen; `Ctrl+Espacio` con la isla enfocada sigue funcionando.
- **Bandeja del sistema:** clic izquierdo muestra/oculta; menú «Mostrar u ocultar la isla» y «Salir de JARVIS» (sale por
  `RunEvent::Exit`, que cierra el sidecar limpio). Los ajustes tienen además «Ocultar isla».
- **Instancia única** (`tauri-plugin-single-instance`): un segundo arranque sale y muestra la isla existente.
- **Ajustes dentro de la isla** (⚙ en el dock): modo de habla, audio del micrófono, manos libres con registro de tu voz
  (el mismo `WakeSettings` del navegador) y el atajo vigente. La calibración (`BenchRecorder`, `check-stt.bat`) sigue siendo una
  herramienta de desarrollo del navegador: guarda archivos a través del servidor de Vite.
- **Corregido:** el aviso «No se pudo abrir el micrófono» ya se puede descartar y no reaparece en cada arranque (si manos libres
  falla, la preferencia guardada pasa a «apagado»).

## Verificado (Linux, X11 sobre Xvfb, build release)
- Clic que atraviesa: sobre la zona transparente el puntero cae en la ventana raíz; sobre la isla y el dock, en la isla; escribir
  en el dock sigue funcionando con el modo alternando.
- `Ctrl+Alt+Espacio` con el foco en otra ventana inicia el push-to-talk (sin micrófono en Xvfb la isla lo dice); con la isla
  oculta, la vuelve a mostrar. Un segundo arranque informa que el atajo ya está tomado.
- Instancia única: con bus D-Bus de sesión el segundo arranque sale con 0 y queda una isla y un sidecar.
- Ajustes: el panel se abre, la ventana crece a lo necesario; «Ocultar isla» la oculta.
- Tests: `hits`/`interactive` en Rust (nunca deja la ventana inalcanzable), `HitRegionReporter` en TS.

## NO verificado
- Todo en Windows (WebView2 y `WS_EX_TRANSPARENT` para el clic que atraviesa; `RegisterHotKey` para el atajo; la bandeja).
- La bandeja en Linux: el contenedor no tiene un host de bandeja; solo se comprobó que crearla no falla.
- En Linux la instancia única necesita un bus D-Bus de sesión (en un escritorio normal existe).
- `Esc` para denegar un permiso con la isla sin foco (prueba 12) sigue sin resolver: un `Esc` global robaría la tecla a todas las apps.

## Alternativas descartadas
- Hit-test por píxel con la región de forma de la ventana (`SetWindowRgn`/input shape): cambia en cada fotograma de animación y es
  distinto por plataforma; la consulta de rectángulos cubre lo mismo con una sola ruta.
- Atajo configurable desde el primer día: añade UI y validación; con una combinación poco usada y el aviso de conflicto basta por ahora.
