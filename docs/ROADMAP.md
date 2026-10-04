# JARVIS — Roadmap y seguimiento

> Actualizar al cerrar cada tarea. Estados: ⬜ pendiente · 🟦 en curso · ✅ hecho · ⛔ bloqueado · ⏸ diferido
> Contexto general: [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)

## Panel rápido

| Fase | Objetivo | Estado | Entregable de validación |
|---|---|---|---|
| 0 | Reducir riesgos, contratos, demo visual mínima | 🟦 casi listo (falta spike en Windows) | Demo de isla + cuervo sobre eventos del protocolo |
| 1 | Columna vertebral (orquestador, proveedores, herramientas, policy) | ✅ completa en lo que no requiere Windows (quedan relevo Tauri y herramientas de Windows) | Tarea de texto de punta a punta, sin UI compleja |
| 2 | Router y evaluador, escalado | ✅ (dry-run y plan→aprobación diferidos a V2; evaluador de tests sin runner en vivo) | Escalado automático con evaluador de tests |
| 3 | Arnés de experimento | 🟦 maquinaria lista; faltan datos (cuota gratis diaria) | Primer resultado de brazos A–D (¡temprano!) |
| 4 | Shell y UI completos | ⬜ | Isla con estados reales, permisos, panel Economy |
| 5 | Memoria + optimización de contexto | ⬜ | Recuperación medida con ablación |
| 6 | Router aprendido + experimento final | ⬜ | Frontera de Pareto costo vs éxito |
| 7 | Voz | ⏸ | Push-to-talk → respuesta hablada |

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
  - [ ] Anthropic y Ollama siguen validados solo con `fetch` simulado, y **sin soporte de herramientas** (rechazan `tools` con error explícito)
- [x] Intent router local por reglas (ES/EN; solo apps conocidas, nada de adivinar)
- [ ] Intent router: clasificador pequeño (diferido; reglas cubren el MVP)
- [x] Registro de herramientas con `ToolDescriptor` (`packages/tools`): `time.now`, `files.read`, `files.write`, `apps.open` (lanzador inyectado)
- [ ] Herramientas de Windows reales (lanzador de apps, portapapeles) → requieren host Windows
- [x] Policy engine: 4 niveles, confirmación, taint, deny/allow lists, log de auditoría (`packages/policy`)
- [x] Bucle de herramientas propuesto por el LLM (ADR-0009): `invokeTool` único para intents locales y llamadas del modelo, máx. 5 pasos, salida no confiable acotada y etiquetada, taint a nivel de tarea. Verificado con modelo real
- [x] Sidecar + IPC (`packages/ipc`, `apps/sidecar`, ADR-0008): NDJSON sobre stdio, token en handshake, permisos con timeout; la demo envía órdenes reales (verificado en Chromium)
- [ ] Relevo del sidecar en el shell Tauri (spawn + stdio↔eventos); requiere Windows
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
- [ ] **Completar la tabla** (68 de 172 celdas, 66 válidas): OpenRouter gratis permite 50 peticiones/día. Alternativa: añadir modelos de Groq/Google (ADR-0014) cuando haya claves en el entorno; la tabla es por modelo, así que se puede ampliar sin rehacer lo hecho
- [ ] Primer análisis con la tabla completa (hoy solo hay 15 tareas completas y son las fáciles: todos los modelos aciertan 100 %, sin discriminación)
- [ ] Ampliar la suite (tareas más difíciles; hoy no hay separación entre modelos en las fáciles)
- [ ] Cargadores HumanEval/MBPP/SWE-bench-Lite (requieren sandbox real, contenedor)
- [ ] Baseline RouteLLM real (Fase 6); varias muestras por celda para la varianza de muestreo

## Fase 4 — Shell y UI (3–4 semanas) ⬜
- [ ] Isla con todos los estados reales; prompts de permiso; panel AI Economy
- [ ] Cuervo con animaciones completas
- [ ] Pruebas de pantalla completa, multi-monitor, DPI

## Fase 5 — Memoria y contexto (3 semanas) ⬜
- [ ] Memoria factual/preferencia/conductual/operacional, política de escritura, olvido, control del usuario
- [ ] Recuperación y presupuesto de contexto; ablación de calidad

## Fase 6 — Router aprendido y experimento final (3–4 semanas) ⬜
- [ ] Bandit contextual (Thompson/LinUCB) con exploración y propensity
- [ ] Curva de aprendizaje, test de deriva, perfiles de usuario simulados
- [ ] Dogfood real 3–4 semanas; calibración del juez LLM vs etiquetas humanas (κ)
- [ ] Redacción de resultados

## Fase 7 — Voz ⏸
- [ ] Push-to-talk → STT local → respuesta → TTS
- [ ] Wake word personalizable
- [ ] Métricas: time-to-first-audio

---

## Preguntas abiertas (necesitan respuesta del usuario)

| # | Pregunta | Por qué importa | Respuesta |
|---|---|---|---|
| 1 | ¿Es tesis con fecha límite o producto abierto? | Define cuánto recortar | _pendiente_ |
| 2 | ¿Qué proveedores/keys y presupuesto hay? ¿GPU para Ollama? | Define brazos del experimento | _pendiente_ |
| 3 | ¿Mezcla ES/EN desde el día 1? | Intent router, STT, dataset | _pendiente_ |
| 4 | ¿El caso de uso dominante es programar? | Evaluador y experimento mucho más simples | _pendiente_ |

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
