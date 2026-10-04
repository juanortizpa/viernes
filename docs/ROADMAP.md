# JARVIS — Roadmap y seguimiento

> Actualizar al cerrar cada tarea. Estados: ⬜ pendiente · 🟦 en curso · ✅ hecho · ⛔ bloqueado · ⏸ diferido
> Contexto general: [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)

## Panel rápido

| Fase | Objetivo | Estado | Entregable de validación |
|---|---|---|---|
| 0 | Reducir riesgos, contratos, demo visual mínima | 🟦 casi listo (falta spike en Windows) | Demo de isla + cuervo sobre eventos del protocolo |
| 1 | Columna vertebral (orquestador, proveedores, herramientas, policy) | ✅ completa en lo que no requiere Windows (relevo Tauri hecho y probado en Linux; quedan herramientas de Windows) | Tarea de texto de punta a punta, sin UI compleja |
| 2 | Router y evaluador, escalado | ✅ (dry-run y plan→aprobación diferidos a V2; evaluador de tests sin runner en vivo) | Escalado automático con evaluador de tests |
| 3 | Arnés de experimento | 🟦 tabla completa para 7 modelos (Groq + Google); faltan tareas más difíciles | Primer resultado de brazos A–D (¡temprano!) |
| R | Respuesta inmediata (acuse, saludos, caché) | ✅ R1–R3 hechos y medidos (acuse 1 ms vs 1 s; caché 1 ms vs ~500 ms, 0 falsos positivos; perfil de estilo) | Saludos y acuses <50 ms, sin progreso falso |
| 4 | Shell y UI completos | 🟦 la isla Tauri usa el sidecar real, deja pasar clics fuera de ella, tiene atajo global, bandeja y ajustes (ADR-0021/0022; probado en Linux); falta Windows (overlay real, pantalla completa, multi-monitor, DPI) | Isla con estados reales, permisos, panel Economy |
| 5 | Memoria + optimización de contexto | 🟦 conversación + recuerdos explícitos hechos y medidos (ADR-0023): recuperación 94 % en prueba retenida, ablación real 0 → 28/28 con +25 tokens; falta lo semántico (embedding neuronal) | Recuperación medida con ablación |
| 6 | Router aprendido + experimento final | ⬜ | Frontera de Pareto costo vs éxito |
| P | Agente de programación (ADR-0024) | 🟦 Gemini CLI → Claude Code con comprobación del proyecto; Gemini probado en real (91 s, sin escalar); falta Windows y Claude real | "en el proyecto X, arregla…" edita, comprueba y lo cuenta por voz |
| 7 | Voz | 🟦 push-to-talk + STT local (probado en Windows), TTS y wake word de dos etapas (estos dos solo con audio simulado) | Push-to-talk → respuesta hablada |

---

## Fase 0 — Reducir riesgos y contratos (1–2 semanas)

**Meta:** que nada de lo siguiente se construya sobre supuestos sin probar, y que desde el día 1
exista algo visible, no solo logs.

### Entregables
- [x] Monorepo pnpm (workspace, tsconfig base, vitest)
- [x] `packages/protocol`: tipos y esquemas zod
  - [x] `PermissionLevel`, `Provenance`, `TaskType`, `Usage`
  - [x] `ModelCapabilities`, `RoutingDecision` (con `propensity`)
  - [x] `Verdict` + regla de escalado (`uncertain` ≠ éxito)
  - [x] `ToolDescriptor`, `PolicyDecision`
  - [x] `OrchestratorEvent` (unión discriminada, fuente única para UI y telemetría)
  - [x] `ExecutionTrace` (esquema del dataset de investigación)
  - [x] Tests de validación
- [x] **Demo visual mínima** (`apps/desktop`)
  - [x] Reducer puro `eventos → estado de la isla` (con tests)
  - [x] Isla colapsada/expandida con Framer Motion
  - [x] Cuervo SVG con estados: idle, listening, thinking, success, error, warning
  - [x] Reproductor de escenarios sobre el protocolo, **etiquetado "DEMO"** (no pasa por progreso real)
  - [x] Prompt de permiso interactivo (permitir/denegar reanuda el escenario)
  - [x] Escenarios: acción local sin LLM, modelo barato, escalado con permiso
  - [x] Captura de pantalla de verificación
- [x] Shell Tauri (`src-tauri`): ventana transparente, siempre encima, sin decoración
  - [x] Esqueleto escrito
  - [x] Compila y corre en Linux (WebKitGTK sobre Xvfb) con el sidecar real (ADR-0021)
  - [ ] **Validado en Windows** ← requiere máquina Windows del usuario
- [x] ADRs en `docs/adr/`
  - [x] 0001 Monorepo y límites de paquetes
  - [x] 0002 Sidecar TypeScript + shell Tauri fino; IPC local con token
  - [x] 0003 Abstracción de proveedores y `ModelCapabilities`
  - [x] 0004 `OrchestratorEvent` como flujo único (UI + telemetría)
  - [x] 0005 Policy engine determinista fuera del LLM; taint tracking
  - [x] 0006 Esquema de traza con `propensity` para evaluación off-policy
  - [x] 0007 SQLite + sqlite-vec en MVP (Postgres diferido)
- [x] `CLAUDE.md` en la raíz que apunta a estos documentos

### Criterio de salida
1. `pnpm typecheck` y `pnpm test` en verde.
2. La demo corre con `pnpm dev` y muestra los tres escenarios.
3. Spike de overlay probado en Windows (transparencia, click-through, pantalla completa, DPI) o
   decisión documentada de pasar a Electron.

### Riesgos abiertos de la fase
- No hay Windows en el entorno de desarrollo remoto: el spike de overlay lo debe ejecutar el usuario.

---

## Fase 1 — Columna vertebral (3–4 semanas) ✅ (salvo ítems de Windows)
- [x] Orquestador: máquina de estados de tarea (`TaskMachine`) + bus de eventos validado contra el protocolo (`packages/core`)
- [x] Registro de proveedores + adaptadores Anthropic, OpenRouter, Ollama + `FakeProvider` (`packages/providers`; tests con `fetch` simulado)
  - [x] **OpenRouter validado contra la API real** (streaming, uso y costo; el costo calculado coincide con el que cobra OpenRouter). Prueba opt-in: `JARVIS_LIVE=1 OPENROUTER_API_KEY=… pnpm test`
  - [x] Groq y Google validados contra las APIs reales (solo texto, sin herramientas; 301 celdas del arnés)
  - [ ] Anthropic y Ollama siguen validados solo con `fetch` simulado, y **sin soporte de herramientas** (rechazan `tools` con error explícito)
- [x] Intent router local por reglas (ES/EN; solo apps conocidas, nada de adivinar)
- [ ] Intent router: clasificador pequeño (diferido; reglas cubren el MVP)
- [x] Registro de herramientas con `ToolDescriptor` (`packages/tools`): `time.now`, `files.read`, `files.write`, `apps.open` (lanzador inyectado)
- [ ] Herramientas de Windows reales (lanzador de apps, portapapeles) → requieren host Windows
- [x] Policy engine: 4 niveles, confirmación, taint, deny/allow lists, log de auditoría (`packages/policy`)
- [x] Bucle de herramientas propuesto por el LLM (ADR-0009): `invokeTool` único para intents locales y llamadas del modelo, máx. 5 pasos, salida no confiable acotada y etiquetada, taint a nivel de tarea. Verificado con modelo real
- [x] Sidecar + IPC (`packages/ipc`, `apps/sidecar`, ADR-0008): NDJSON sobre stdio, token en handshake, permisos con timeout; la demo envía órdenes reales (verificado en Chromium)
- [x] Relevo del sidecar en el shell Tauri (spawn + stdio↔`Channel`, token, generaciones, cierre limpio; ADR-0021). Probado en Linux; **falta Windows**
- [x] Empaquetar el sidecar: `pnpm --filter @jarvis/sidecar build` → `dist/sidecar.mjs` (un solo archivo, corre con `node` sin `tsx`; probado en e2e)
- [ ] Binario autocontenido del sidecar para distribuir (Node SEA o similar); requiere host Windows
- [x] Telemetría persistida: `SqliteTraceStore` (`packages/storage`, `node:sqlite`, sin dependencias nativas); el sidecar la usa con `JARVIS_DATA_DIR` o `traceDb` en la config
- [x] Probar un adaptador contra una API real (OpenRouter, ver arriba)

## Fase 2 — Router y evaluador (3 semanas) ✅
- [x] Estrategias de router intercambiables (siempre-premium, siempre-barato, reglas) — `router` en la config, ADR-0011
- [x] Filtrado por capacidades (visión, herramientas, contexto, sensibilidad de datos) con motivo de rechazo en la traza
- [x] Clasificador de tarea por reglas (tipo + complejidad) y `baselineCostUsd` (baseline always-premium) en cada traza
- [x] Detectar datos sensibles en el input (`detectSensitive`: solo modelos locales, o falla) y exigir `supportsTools` (modelo + adaptador) cuando la tarea toca archivos/proyectos (`needsTools`)
- [x] Evaluadores (ADR-0012): heurísticas de respuesta, evaluador de código con runner inyectado (sin runner en vivo: requiere sandbox, Fase 3), postcondición de herramienta
- [x] Cascada: escalado al siguiente modelo elegible (orden de config débil→fuerte si todo es gratis), también ante errores del proveedor
- [x] Escalado seguro mínimo: no se escala tras una herramienta con efectos secundarios
- [x] Checkpoints: `Tool.checkpoint` + rollback antes de escalar (hoy `files.write`); evento `checkpoint.restored`
- [ ] ⏸ V2: dry-run y plan→aprobación para herramientas sin checkpoint (p. ej. `apps.open`, que sigue sin escalar)
- [x] Contabilidad de costo incluyendo costo del evaluador (suma `verdict.usage`; hoy los evaluadores son gratis)
- [x] Todo gratis: `freeOnly` + `jarvis.config.free.example.json` (OpenRouter `:free`); sin juez LLM de pago
- [x] Escalada validada con modelos gratuitos reales (`live.cascade.test.ts`, opt-in `JARVIS_LIVE=1`): dos saltos reales (400 de modelo inexistente → 429 de Gemma gratis → Nemotron) y salto por veredicto; costo 0
- [x] ADR: cascada vs ruteo predictivo (provisional: reglas → cascada con evaluador → predictivo solo con datos del arnés)

## Fase 3 — Arnés de experimento (3 semanas) 🟦 (ADR-0013)
- [x] `packages/harness`: suite semilla de 43 tareas ES/EN con ground truth determinista (exact, contains, regex, number, código JS con tests); cada tarea trae una respuesta de referencia que debe pasar su propio check (test)
- [x] Sandbox de código con `node --permission` (sin fs fuera del tmp, sin procesos, timeout). **Sin aislamiento de red**: no sirve para código arbitrario de herramientas
- [x] **Tabla contrafactual**: modelo × tarea, una vez; JSONL reanudable; tokens (no costo); errores de transporte no cuentan como evidencia; cuota diaria detiene la corrida limpiamente; orden aleatorio con semilla
- [x] Simulador de replay offline que reutiliza `RulesRouter`, `escalationLadder`, `routeRequestFor` y el evaluador heurístico reales
- [x] Baselines: A premium, B barato, C reglas, oráculo, cascada (evaluador heurístico real y evaluador perfecto), `learned_cv_simplified` (**no** es RouteLLM)
- [x] Análisis: bootstrap pareado (IC 95 %, semilla fija), Δ éxito y ahorro vs A, frontera de Pareto, calibración del evaluador contra ground truth
- [x] CLI: `pnpm --filter @jarvis/harness harness run|report`; guard que se niega a usar modelos de pago sin `--allow-paid`
- [x] **Tabla completa** para 7 modelos de Groq y Google × 43 tareas (301 celdas, 0 errores; `harness.config.multi.json`). Los 4 modelos de OpenRouter gratis siguen parciales (50 peticiones/día) y quedan fuera del informe
- [x] Primer análisis con la tabla completa (`data/report.md`, precios supuestos): qwen3.8-27b 86 %, gpt-oss-20b 97.7 %, el resto 100 %. B/cascada heurística ahorran ~36 % con −2.3 % de éxito (IC incluye 0); el evaluador heurístico dio 7 falsos positivos y 0 rechazos. Aún poca discriminación: la suite es fácil
- [ ] Ampliar la suite (tareas más difíciles; hoy no hay separación entre modelos en las fáciles)
- [ ] Cargadores HumanEval/MBPP/SWE-bench-Lite (requieren sandbox real, contenedor)
- [ ] Baseline RouteLLM real (Fase 6); varias muestras por celda para la varianza de muestreo

## Fase R — Respuesta inmediata (ADR-0015) ✅ R1, R2 y R3 hechos (falta validar con uso real)
**Meta:** que lo repetitivo responda al instante y lo largo acuse recibo al instante, sin progreso falso y sin falsos positivos.
**Entregable de validación:** latencia al primer mensaje <50 ms en saludos y acuses, 0 respuestas servidas fuera de la lista permitida.

### R1 — Acuse y respuestas fijas (MVP)
- [x] Contrato: evento `instant.issued` en `packages/protocol` (+ reducer de la isla y etiqueta en UI) y `source: instant` en la traza
- [x] Reglas ES/EN para saludos/cortesías (`packages/core`, junto al intent router), con tests de lo que NO debe capturar
- [x] Acuse al clasificar tarea larga o con herramientas; el texto solo confirma recepción
- [x] Prueba e2e por el sidecar: acuse llega antes que la primera respuesta del modelo

### R2 — Caché semántico ✅
- [ ] Medir tasa de preguntas repetidas en uso real (las trazas no guardan el texto; ver `instant.list`: `seen`/`hits`). Pendiente de datos reales
- [x] `SemanticCache` + `InstantStore` (SQLite, embedder hasheado intercambiable), umbral alto, reglas de entrada y exclusión del ADR
- [x] Evaluar con el arnés (`harness instant-eval`): 94.7 % de aciertos, 0 falsos positivos / 776 sondas. Con conjunto escrito por mí; falta validarlo con uso real
- [x] Control del usuario: listar, borrar, desactivar (herramientas `instant.*` + frases locales; se integra con Fase 5)
- [ ] Embedding neuronal (≈20–80 MB) solo si el real-world hit rate lo justifica

### R3 — Estilo y preferencias ✅
- [x] `StyleTracker` (contadores, sin texto guardado, frases fijas al prompt), controles del usuario, verificado con Groq real
- [x] Decisión: no se entrena un modelo; se reconsidera solo con datos de uso real
- [ ] Medir si el usuario prefiere las respuestas con perfil (necesita señal de satisfacción: Fase 4/5)

## Fase 4 — Shell y UI (3–4 semanas) 🟦
- [x] Isla con todos los estados reales: escuchando (micrófono abierto), transcribiendo, recibido/rápida/caché (capa inmediata), pensando, ejecutando, permiso, éxito, error, aviso
- [x] Prompts de permiso: `Denegar` con foco por defecto y atajo `Esc`; nunca se concede por accidente con Enter
- [x] Botón **Cancelar** real (`task.cancel`; aborta también una transcripción); solo aparece con una tarea del sidecar, nunca en demos
- [x] **Panel AI Economy** (`economy.get`): tareas, éxito, gasto, tokens, tareas sin LLM (locales/rápidas/caché), escaladas, latencias y modelos más usados, calculado desde las trazas. Sin precios configurados **no inventa ahorro** (lo dice). Se abre con clic en la isla
- [x] Cuervo: aros de escucha con el nivel real del micrófono; `prefers-reduced-motion` respetado (`MotionConfig reducedMotion="user"`)
- [x] Diseño verificado en Chromium a DPR 1/1.25/1.5/2 en una ventana de 420 px (sin desbordes)
- [x] **Relevo del sidecar en Tauri** (ADR-0021): la isla flotante usa el sidecar real. En la app real (Linux, release): órdenes locales, saludo, cascada y reintento; permisos solo en simulación de Chromium; voz sin probar (no hay micrófono). **Falta Windows**
- [x] `island.bat` → `scripts/island.mjs`: empaqueta el sidecar, compila la isla solo si cambió el código y la deja corriendo sin consola (`--dev` para `tauri dev`)
- [x] Dock de la isla (orden escrita, push-to-talk, manos libres; estado del sidecar con Reintentar) y ventana que mide lo que la isla (`WindowFitter`)
- [x] La respuesta del modelo se queda visible al terminar (antes «Listo» la borraba) y el detalle se limita a 4 líneas
- [x] Ajustes dentro de la isla (⚙): modo de habla, audio, manos libres con registro de tu voz, atajo vigente, ocultar (ADR-0022). La calibración sigue en el navegador (herramienta de desarrollo)
- [x] Clic que atraviesa por regiones: la UI informa sus rectángulos y el shell alterna `set_ignore_cursor_events` según el cursor; nunca deja la ventana inalcanzable (ADR-0022). Probado en X11; **falta Windows**
- [x] Bandeja (mostrar/ocultar, salir) e instancia única (ADR-0022)
- [ ] Pruebas de pantalla completa, multi-monitor y DPI reales — Windows (lista en `docs/SPIKE_OVERLAY.md`)
- [x] Atajo global de push-to-talk `Ctrl+Alt+Espacio` (ADR-0022; probado en X11, **falta Windows**)
- [ ] `Esc` para denegar un permiso con la isla sin foco (un `Esc` global robaría la tecla a todas las apps; sin decidir)
- [x] Cuervo "hablando" (pico animado, solo cuando el sintetizador informa que habla)
- [ ] Revisión de diseño con el usuario

## Fase 5 — Memoria y contexto (3 semanas) 🟦 (ADR-0023)
- [x] **Memoria de conversación** (`ConversationMemory`): los últimos intercambios van al modelo; solo RAM, se olvida a los 20 min o con «olvida esta conversación»; los seguimientos se clasifican con la pregunta que responden y nunca usan la caché; sin secretos ni respuestas basadas en contenido no confiable. Arregla el caso real «¿quién ganó el mundial?» → «masculino» (verificado con Groq)
- [x] Memoria **factual y de preferencias** (`MemoryBook` + SQLite): solo por petición explícita («recuerda que…»); preferencias siempre aplicadas, datos por relevancia con presupuesto; rechaza secretos, duplicados y exceso
- [x] Política de escritura: el modelo **lee pero no escribe** memoria (`Tool.modelCallable=false`, también para alias/caché/estilo)
- [x] Olvido y control del usuario: «qué recuerdas de mí», «olvida que…» (pregunta si es ambiguo), «borra toda mi memoria» (con confirmación), activar/desactivar, panel Memoria en la isla y el navegador
- [x] Conductual = perfil de estilo (ADR-0015 R3); operacional = alias aprendidos (ADR-0010)
- [x] Veracidad: evento `context.used` (ids, nunca texto) → chips «🧠 recuerdos · 💬 contexto»; `ExecutionTrace.context` para el dataset
- [x] **Recuperación medida** (`harness memory-eval`): corpus propio con negativas difíciles y huecos semánticos, desarrollo/prueba retenida, comparada contra todo-siempre, top-3 y solo-embedding
- [x] **Ablación con modelo real** (`harness memory-ablation`, 2 modelos Groq): sin memoria 0/28 → recuperación 28/28 con +25 tokens (meter todo: 28/28 con +400–590); 0 fugas en respuestas generales
- [ ] Huecos semánticos y entre idiomas (0/6 con recuperación por palabras): embedding neuronal multilingüe local o reordenar con LLM; decidir con datos de uso real
- [ ] Memoria propuesta por el modelo con bandeja de revisión del usuario (V2)
- [ ] Actualizar/fusionar recuerdos contradictorios (V2)
- [ ] Presupuesto de contexto para conversaciones largas (resumir turnos viejos en vez de descartarlos)

## Fase 6 — Router aprendido y experimento final (3–4 semanas) ⬜
- [ ] Bandit contextual (Thompson/LinUCB) con exploración y propensity
- [ ] Curva de aprendizaje, test de deriva, perfiles de usuario simulados
- [ ] Dogfood real 3–4 semanas; calibración del juez LLM vs etiquetas humanas (κ)
- [ ] Redacción de resultados

## Fase 7 — Voz 🟦 (ADR-0016)
- [x] Push-to-talk (botón mantenido o Ctrl+Espacio con la ventana enfocada) → WAV 16 kHz → sidecar → STT local → tarea de voz por el pipeline normal
- [x] `packages/voice`: WAV, puerta de silencio anti-alucinación, `Transcriber`, adaptador whisper.cpp por argv (binario/modelo que pone el usuario)
- [ ] **Probar whisper.cpp real** (precisión ES/EN, latencia por modelo). Hoy solo hay pruebas con un binario de mentira
- [x] Atajo global (`Ctrl+Alt+Espacio`, ADR-0022)
- [ ] Micrófono en WebView2 (Windows)
- [x] TTS con voces del sistema (ADR-0017): acuse hablado, respuestas, interrupción con Esc/al hablar, modos Solo si hablo/Siempre/Nunca, cuervo con pico animado, métrica time-to-first-audio (**audio real sin probar**)
- [ ] Voces: probar calidad en Windows; excluir voces en línea si se quiere privacidad total; TTS neuronal local si no basta
- [x] Wake word personalizable en dos etapas (ADR-0018): filtro en el equipo con tu voz (MFCC+DTW, 0,64 % de un núcleo) → verificación con whisper tiny → orden → ventana de continuación de 10 s; indicador visible, opt-in, descarta lo que no es para el asistente. **Solo probado con audio sintético**
- [x] Calidad de transcripción: correcciones de pipeline + herramienta de calibración con la voz del usuario (ADR-0019)
- [x] Transcripción en la nube gratis en carrera (Groq whisper + Gemini que entiende lo que quisiste decir) con whisper local de respaldo; medido en un corpus de voz natural: 20/20 y 19/20 acciones correctas, mediana 1,2 s (ADR-0020)
- [ ] Ejecutar la calibración (`check-stt.bat`) con la voz real del usuario
- [ ] Calibrar el filtro con tu voz real en Windows (sensibilidad/puntaje), medir falsos positivos/negativos y CPU en reposo
- [ ] Cancelación de eco real y barge-in por voz (hoy se ignora el micrófono mientras habla)
- [ ] STT en streaming (V2)

## Fase P — Agente de programación (ADR-0024) 🟦
- [x] `packages/agents`: adaptadores Gemini CLI y Claude Code (stream-json, tarea por stdin, límite total e inactividad, corte del árbol de procesos), etapas en español, cadena el-más-barato-primero con comprobación del proyecto y contexto del intento anterior
- [x] Herramienta `code.agent` (sensible, salida no confiable, cancelable, progreso real), proyectos por alias (`coding.projects`), orden directa "en el proyecto X, …", resumen hablado
- [x] `setup`: detecta Gemini CLI / Claude Code (`--install-agents` instala Gemini CLI), siembra JARVIS como proyecto y conserva la lista
- [x] Prueba real con Gemini CLI 0.62 (bug arreglado y comprobado en 91 s)
- [ ] Probar en Windows (shims `.cmd`, `taskkill`, login de Gemini)
- [ ] Probar Claude Code real con la sesión de Claude Pro
- [ ] Que el LLM elija `code.agent` por sí solo en peticiones de programación sin "en el proyecto…" (hoy puede, vía herramientas; sin medir)
- [ ] Usar el agente para manejar otras apps (scripts de automatización) — V2

---

## Preguntas abiertas (necesitan respuesta del usuario)

| # | Pregunta | Por qué importa | Respuesta |
|---|---|---|---|
| 1 | ¿Es tesis con fecha límite o producto abierto? | Define cuánto recortar | **Producto personal** (2026-10-04): prioridad = utilidad diaria; el experimento (Fases 3/6) pasa a segundo plano |
| 2 | ¿Qué proveedores/keys y presupuesto hay? ¿GPU para Ollama? | Define brazos del experimento | **100 % gratis.** APIs gratuitas (Groq, Gemini, OpenRouter) + suscripciones **Claude Pro** y **Gemini (plan de pago de la app)**. Las suscripciones no dan API: se aprovechan vía **Claude Code** y **Gemini CLI** locales |
| 3 | ¿Mezcla ES/EN desde el día 1? | Intent router, STT, dataset | **Solo español** |
| 4 | ¿El caso de uso dominante es programar? | Evaluador y experimento mucho más simples | **Asistente general que sirva para programar**, y apoyarse en esa capacidad para manejar las demás apps |

## Registro de decisiones y cambios

| Fecha | Cambio |
|---|---|
| 2026-10-03 | Revisión de arquitectura inicial. Cambios propuestos: SQLite en vez de Postgres en MVP; núcleo TS como sidecar; IPC local sin puertos; MCP como adaptador; voz al final. |
| 2026-10-03 | Inicio de Fase 0; añadidos `PROJECT_CONTEXT.md`, `ROADMAP.md` y demo visual temprana al alcance. |
| 2026-10-03 | Fase 0 casi cerrada: monorepo, `packages/protocol` (7 tests), demo de isla + cuervo (`pnpm dev`, 9 tests de reducer y player, verificada con capturas en Chromium), 7 ADRs, esqueleto Tauri. **Pendiente:** spike de overlay en Windows (`docs/SPIKE_OVERLAY.md`), no compilado ni probado. |
| 2026-10-04 | Fase 1, primer corte vertical: `policy`, `tools`, `providers`, `core` (orquestador + bus + intent router + `StaticRouter` provisional). 44 tests y typecheck en verde. Rama local-intent y rama modelo emiten `OrchestratorEvent` válidos y guardan `ExecutionTrace`. Pendiente: sidecar/IPC, SQLite, bucle de herramientas con LLM. |
| 2026-10-04 | Fase 1, sidecar + IPC: `packages/ipc` (mensajes zod + NDJSON), `apps/sidecar` (servidor por stdio, config, lanzador de apps por alias, runtime), puente solo-dev en Vite y fuente "live" en la UI (ADR-0008). 73 tests, incluido un e2e que lanza el proceso real. Sin proveedor configurado responde `offline-echo`, etiquetado como tal. El flujo de permiso en el navegador solo está probado en tests del servidor (no hay regla local sensible en la UI aún). |
| 2026-10-04 | Fase 1 cerrada salvo Windows: OpenRouter probado con la API real; `packages/storage` (SQLite); bucle de herramientas con LLM (ADR-0009); sidecar empaquetado como un solo `.mjs`. Hallazgo de la prueba real: OpenAI/OpenRouter rechazan nombres de función con punto (`time.now`), así que el adaptador los codifica en el borde; las pruebas con `fetch` simulado no podían detectarlo. Un modelo real (gpt-4o-mini) resistió una inyección de prompt; la garantía de que el policy engine bloquea está en los tests deterministas, no en esa prueba. |
| 2026-10-04 | Pruebas en Windows (primer contacto): "qué hora es" y "abre VS Code" funcionan; fallaban Paint, abrir otra pestaña y "qué día será mañana". Añadidos alias (`paint`→`mspaint`, navegador/pestaña nueva→`msedge`), herramienta determinista `time.date` con regla local para hoy/mañana/ayer, y `time.now` ahora devuelve hora local legible (antes ISO en UTC). "Otra pestaña" abre el navegador por defecto de Edge; no controla pestañas existentes (eso sería V2). |
| 2026-10-04 | Automejora, primer paso (ADR-0010): `AppCatalog` (config > aprendido > escaneado), escáner de Menú Inicio, alias aprendidos con confirmación del policy engine y persistidos en SQLite, `aliases.list/forget`, y el lanzador solo abre comandos del catálogo. 105 tests. **No probado en Windows real** (el escáner solo se probó con carpetas temporales). Pendiente/V2: memoria negativa de rechazos, apps UWP, skills declarativas. |
| 2026-10-04 | Windows: Teams y otras apps de la Store no aparecían porque no tienen `.lnk`. El escáner ahora también lee `Get-StartApps` y las lanza con `explorer.exe shell:AppsFolder\<AppID>` (argv, sin shell). **Sin probar en Windows real.** |
| 2026-10-04 | Inicio de Fase 2 (ADR-0011): estrategias de router, filtrado por capacidades, clasificador de tarea, `baselineCostUsd`. 120 tests. Pendiente de la fase: evaluadores, cascada con escalado, costo del evaluador, detección de datos sensibles. |
| 2026-10-04 | Fase 2, evaluadores y cascada (ADR-0012): `Evaluator`s deterministas gratuitos, bucle de intentos con escalado por veredicto o error del proveedor, no escala tras efectos secundarios, `freeOnly`, config de ejemplo con modelos `:free`. Prueba en vivo con OpenRouter gratis: ruteo y veredicto correctos (fácil→modelo pequeño, código→el más fuerte, costo 0); la escalada solo está probada con proveedores falsos. UI: una respuesta nueva ya no se concatena a la razón/intento anterior. 136 tests. |
| 2026-10-04 | Cierre de Fase 2: `detectSensitive` + `needsTools` como restricciones duras del ruteo, `Tool.checkpoint` con rollback antes de escalar (`files.write`), prueba en vivo de la cascada con modelos gratis. Hallazgo real: un error del proveedor no escalaba si los evaluadores abstenían o ignoraban `failure`; ahora un intento roto es siempre un fallo. |
| 2026-10-04 | Inicio de Fase 3 (ADR-0013): `packages/harness` (suite semilla, sandbox, tabla contrafactual, replay, baselines, bootstrap, CLI). 163 tests. Corrida real con 4 modelos gratuitos (2.6B–550B): OpenRouter gratis corta a 50 peticiones/día, así que la tabla va en 68/172 celdas; el informe parcial no discrimina (tareas fáciles, 100 % en todos), lo cual es resultado de la muestra, no del router. Gemma gratis está limitada de forma persistente (429) y quedó fuera de la escalera del arnés. |
| 2026-10-04 | Proveedores Groq (OpenAI-compatible, generalizado desde OpenRouter) y Google AI Studio (adaptador propio) + `ModelCapabilities.tier` para ordenar modelos de igual precio entre proveedores (ADR-0014). `harness list-models` y config de ejemplo multi-proveedor. 172 tests con `fetch` simulado. **Sin validar contra las APIs reales (faltan `GROQ_API_KEY` y `GEMINI_API_KEY` en el entorno).** Captura de cuotas de AI Studio del usuario: los modelos de texto (Gemini 2 Flash/Flash Lite) muestran límite 0/0 en esa cuenta y los "ilimitados" son Live API (audio en tiempo real), inutilizables para texto: hay que ver qué modelos de texto tienen cuota. |
| 2026-10-04 | Claves de Groq y Gemini en el entorno: adaptadores Groq y Google **validados en vivo**. IDs de Llama de la config de ejemplo ya no existían; Gemini 2.5 no está disponible para cuentas nuevas. Modelos usables: gpt-oss-20b/120b y qwen3.8-27b (Groq); gemma-4-26b/31b, gemini-3.1/3.5-flash-lite (Google). Tabla contrafactual completa (7×43) e informe regenerado; un 500 transitorio de Gemma se reintentó. Pendiente: tareas más difíciles, probar herramientas con Groq/Google. |
| 2026-10-04 | Propuesta de respuesta inmediata registrada. |
| 2026-10-04 | Contexto actualizado: capa de respuesta inmediata como Fase R (R1 acuse/saludos MVP, R2 caché semántico V2, R3 estilo investigación), ADR-0015 con reglas duras (lista de exclusión, `source: instant`, control del usuario). Nada implementado aún. |
| 2026-10-04 | Fase R1 hecha: `RuleInstantResponder`, evento `instant.issued`, `ExecutionTrace.instant`, reducer de la isla, opción `instantResponses`. 181 tests. Medido con Groq real: acuse a 1 ms frente a ~1 s del primer token; saludos sin red. Tests antiguos que usaban "hola" como prompt de modelo se cambiaron. |
| 2026-10-04 | Fase R2 hecha: `SemanticCache`, `SqliteInstantStore`, guarda `sameContent`, aprendizaje solo tras veredicto de éxito sin herramientas/taint/sensibles, controles del usuario, `harness instant-eval`. 196 tests. Bugs que atrapó la validación: el coseno podía dar 1.0000002 y el esquema `confidence ≤ 1` lo rechazaba; mi lista de exclusión bloqueaba "tell me"/"más grande". Verificado con Groq real (1 ms vs ~500 ms; Francia ≠ Italia). Riesgo abierto: una respuesta errónea aprobada por el evaluador heurístico puede guardarse. |
| 2026-10-04 | Fase R3 hecha: `StyleTracker` (registro voseo/tuteo/usted y preferencia por brevedad, solo contadores), hint de frases fijas en el prompt, controles del usuario, opción `styleProfile`. 202 tests. A/B con Groq real (1 muestra): con perfil respondió en voseo y más breve. Un 429 de Groq (8000 tokens/min) durante la prueba se reportó correctamente como `task.error`. Decisión: no se entrena un modelo propio. |
| 2026-10-04 | Voz (ADR-0016): `packages/voice`, `voice.submit` por IPC, push-to-talk con micrófono abierto solo al pulsar, puerta de silencio, cancelación. **Reconocimiento real NO probado**: compilar whisper.cpp fue denegado por el sistema de permisos, así que se probó con un binario stand-in. Fase 4 en navegador: panel AI Economy desde trazas (no inventa ahorro sin precios), Cancelar, permisos con Deny por defecto, cuervo con nivel real, reduce-motion, DPR 1–2 verificado. 231 tests. Pendiente en Windows: relevo Tauri, overlay, multi-monitor, atajo global. |
| 2026-10-04 | `setup.bat`/`start.bat` + `scripts/` (Node): instalación en un paso (pnpm, claves en `jarvis.env`, whisper.cpp + modelo, config según las claves presentes) y arranque solo en 127.0.0.1. Probado en Linux con modelos reales (la cascada escaló sola de OpenRouter, cuota diaria agotada, a Groq); **sin probar en Windows**. |
| 2026-10-04 | Primer contacto con voz real en Windows: transcribe, pero "abre la calculadora" no abría nada. Causas (mías): (1) el router local solo entendía "abre calculadora" exacto, no artículos/cortesías/formas habladas ("puedes abrir la…, por favor", "abrime", "open the…"), así que la orden iba al LLM; (2) el LLM llamaba `apps.open` con un nombre en inglés (`calculator`) que no era el comando (`calc`) y se rechazaba. Arreglo: `extractOpenTarget`, el lanzador resuelve nombres vía catálogo (sigue rechazando todo lo desconocido), la herramienta le dice al modelo qué apps existen, whisper por defecto en `es` con un prompt de vocabulario de tus apps. Verificado con Groq real. 264 tests. |
| 2026-10-04 | TTS (ADR-0017): `speech/` (texto hablable sin markdown/código/tablas, elección de voz rioplatense, controlador con cola y cancelación, `TaskSpeaker` desde eventos), modos de habla, cuervo hablando, métrica time-to-first-audio. 281 tests. Probado en Chromium con sintetizador simulado; **audio real pendiente en Windows**. Riesgo abierto para wake word: eco del propio asistente. |
| 2026-10-04 | Wake word (ADR-0018): `TemplateSpotter` (MFCC+DTW sobre tu voz), `Endpointer`, `matchWakeWord`, `WakeController` con ventana de 10 s, `wake.verify` en el sidecar (descarta sin rastro lo que no es para él), escucha continua con registro de voz, sensibilidad, indicador ● y cuenta atrás real, pausa mientras habla, setup descarga whisper tiny. 318 tests. Validado end-to-end en Chromium con una línea de tiempo de audio sintético (palabra → orden → orden sin palabra → vuelta a reposo; 2 verificaciones, 0 por frases ajenas). **Sin voz real**: el umbral automático quedó justo ante audio distinto del de registro, por eso hay sensibilidad y un indicador de calibración. |
| 2026-10-04 | Feedback: la voz funciona pero la transcripción exige hablar despacio. Causas encontradas en mi propio pipeline y corregidas (ADR-0019): audio perdido durante la verificación de «jarvis», frases cortadas a 600 ms de pausa (ahora 900), remuestreo sin filtro (ahora FIR pasa-bajos), audio sin nivelar ni margen, push-to-talk que decía «Escuchando» antes de abrir el micrófono, prompt repetitivo; `setup.bat` descarga `small`. Nueva herramienta de calibración con tu voz (`check-stt.bat` + «Prueba de transcripción» en la UI) y selector «Audio del navegador». 334 tests. **Mejora real sin medir con voz real.** |
| 2026-10-04 | ADR-0020: corpus de 20 frases rioplatenses con 8 voces (TTS de Gemini), limpio y degradado. Medido: whisper-turbo 15/20 acciones correctas; Gemini 3.5 flash-lite (oído+entendido) 18–19/20; **carrera Groq+Gemini en producción 20/20 y 19/20, mediana 1,2 s**. Descubierto midiendo: el prompt de vocabulario hacía que whisper regurgitara la lista de apps ("abre paint" → "abre la calculadora…"); Gemini 3.1 varía hasta 19 s; los TTS leen las instrucciones de estilo. Añadido: `GroqTranscriber`, `GeminiTranscriber` (heard/meant con salvaguarda), `RaceTranscriber`, `FallbackTranscriber`, limpieza de habla y coincidencia fonética de apps, aviso de voz al LLM, `stt-eval`. Bug atrapado por test: se ejecutaba la transcripción rápida en vez de la buena. 369 tests. **Sin probar con la voz real del usuario.** |
| 2026-10-04 | **Relevo del sidecar en Tauri (ADR-0021):** el shell lanza `node sidecar.mjs` con token, reenvía stdio por un `Channel` (generaciones: un proceso viejo nunca toca al nuevo), cierre limpio y log en `.jarvis/sidecar.log`; `tauriTransport()` adapta `LiveClient` sin cambiar el protocolo. `island.bat` arranca la isla real; dock con orden/voz/manos libres; ventana ajustada a la isla; iconos del cuervo. Probado en Linux (WebKitGTK/Xvfb, release): local, saludo, cascada real OpenRouter 429 → Groq, matar sidecar → Reintentar, recarga sin sidecars duplicados, sin huérfanos al matar el shell; `tauri dev` con el puente de Vite apagado. Bug encontrado al probar: la isla borraba la respuesta del modelo al terminar. 381 tests TS + 4 Rust. **Sin probar en Windows** (compilación MSVC, WebView2, micrófono, overlay). |
| 2026-10-04 | **Isla como overlay (ADR-0022):** clic que atraviesa por regiones (la UI informa rectángulos, el shell sondea el cursor; sin regiones o sin cursor siempre clicable), atajo global `Ctrl+Alt+Espacio` para push-to-talk (muestra la isla si estaba oculta; avisa si otra app lo tiene), bandeja (mostrar/ocultar, salir), instancia única, ajustes de voz dentro de la isla (⚙). Bugs corregidos: el aviso de micrófono no se podía descartar y manos libres volvía a intentarse en cada arranque tras fallar. Probado en Linux/X11 (Xvfb, release): clics a la ventana raíz fuera de la isla, atajo sin foco, ocultar → atajo la muestra, segunda instancia sale (con D-Bus). 382 tests TS + 6 Rust. **Sin probar en Windows.** |
| 2026-10-04 | Primer `island.bat` en Windows: fallaba con «"tauri" no se reconoce» porque `@tauri-apps/cli` se añadió a las dependencias pero `node_modules` era anterior. `island.mjs` ahora ejecuta `pnpm install --frozen-lockfile` si falta el CLI (cualquier `git pull` que añada dependencias ya no rompe el arranque) y deja de usar `shell: true` con argumentos (aviso DEP0190). Probado quitando el CLI en Linux. |
| 2026-10-04 | **Primer uso en Windows: la isla se congelaba («No responde») al pulsarla dos veces.** Interbloqueo mío en el clic que atraviesa: el sondeo mantenía el cerrojo de las regiones mientras preguntaba el cursor a la ventana (en Windows espera al hilo principal) y `set_hit_regions`, síncrono en el hilo principal, esperaba ese cerrojo. Ahora el sondeo usa una copia (`snapshot`) y nunca llama a la ventana con un cerrojo tomado. En Linux no se reproducía (esas consultas no pasan por el hilo principal), así que la corrección se razonó desde el código y se comprobó que no regresa (25 clics rápidos, sigue respondiendo); **falta confirmarlo en Windows**. 7 tests Rust. |
| 2026-10-04 | Respuestas del usuario: producto personal, 100 % gratis (APIs gratuitas + Claude Pro y Gemini por suscripción), solo español, asistente general con foco en programar. Como la isla real en Tauri ya existe (ADR-0021/0022), el orden propuesto pasa a ser: (1) agente de programación delegando en Claude Code / Gemini CLI locales, (2) memoria, (3) cerrar la validación de la isla en Windows. Fases 3/6 (experimento) en segundo plano. |
| 2026-10-04 | **Memoria (ADR-0023).** Caso real: «¿quién ganó el mundial?» → «¿masculino o femenino?» → «masculino» → «¿qué quieres hacer con la palabra masculino?». Reproducido con Groq antes del cambio y corregido después. M1: memoria de conversación (RAM, 20 min, seguimientos con contexto en ruteo y sin caché, sin secretos ni contenido no confiable). M2: recuerdos explícitos («recuerda que…») en SQLite, preferencias siempre y datos por relevancia, el modelo lee pero no escribe (`modelCallable`), control completo por voz/texto y panel. M3: `memory-eval` (recupera 88 %/94 % dev/prueba; 100 % y 5 % de falsa inyección en consultas normales) y ablación real con 2 modelos (0 → 28/28 por +25 tokens; meter todo cuesta +400–590; 0 fugas). Fallos encontrados midiendo y corregidos: «≤ 4 palabras = seguimiento» pegaba la pregunta anterior y recuperaba un recuerdo ajeno; «estoy» como palabra temática hizo que el modelo inventara una respuesta; mi propia evaluación fallaba con espacios no separables y aprobaba por suerte. Límite declarado: huecos semánticos/entre idiomas. **Sin probar en Windows.** |
| 2026-10-04 | **Agente de programación (ADR-0024):** `packages/agents` (Gemini CLI → Claude Code, el más barato primero; escala si falla, se queda sin cuota o falla la comprobación del proyecto), herramienta `code.agent` sensible y no confiable con progreso real y cancelación, orden directa "en el proyecto X, …", proyectos en `coding.projects`, resumen hablado, `setup` detecta los CLIs. Hallazgos reales: Gemini CLI sin interfaz rechaza carpetas no confiables (se pasa `GEMINI_CLI_TRUST_WORKSPACE`) y se cuelga reintentando 503 (corte por inactividad + comprobación igual). Prueba real: bug arreglado en 91 s sin escalar. De paso: el TTS cortaba oraciones en "app.js" (corregido); la salida no confiable de una orden directa ya no entra a la memoria de conversación. |
| 2026-10-04 | **`main` no compilaba:** la regla `tools` del `.gitignore` (pensada para la carpeta raíz de descargas) ignoraba en silencio todo archivo nuevo dentro de `packages/tools/`, así que `packages/tools/src/memory.ts` nunca se subió. Regla cambiada a `/tools` y el módulo reescrito a partir de sus llamadas y tests (ADR-0023 memoria): 461 tests en verde. |
