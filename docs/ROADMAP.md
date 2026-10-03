# JARVIS — Roadmap y seguimiento

> Actualizar al cerrar cada tarea. Estados: ⬜ pendiente · 🟦 en curso · ✅ hecho · ⛔ bloqueado · ⏸ diferido
> Contexto general: [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)

## Panel rápido

| Fase | Objetivo | Estado | Entregable de validación |
|---|---|---|---|
| 0 | Reducir riesgos, contratos, demo visual mínima | 🟦 en curso | Demo de isla + cuervo viendo eventos reales del protocolo |
| 1 | Columna vertebral (orquestador, proveedores, herramientas, policy) | ⬜ | Tarea de texto de punta a punta, sin UI compleja |
| 2 | Router y evaluador, escalado | ⬜ | Escalado automático con evaluador de tests |
| 3 | Arnés de experimento | ⬜ | Primer resultado de brazos A–D (¡temprano!) |
| 4 | Shell y UI completos | ⬜ | Isla con estados reales, permisos, panel Economy |
| 5 | Memoria + optimización de contexto | ⬜ | Recuperación medida con ablación |
| 6 | Router aprendido + experimento final | ⬜ | Frontera de Pareto costo vs éxito |
| 7 | Voz | ⏸ | Push-to-talk → respuesta hablada |

---

## Fase 0 — Reducir riesgos y contratos (1–2 semanas)

**Meta:** que nada de lo siguiente se construya sobre supuestos sin probar, y que desde el día 1
exista algo visible, no solo logs.

### Entregables
- [ ] Monorepo pnpm (workspace, tsconfig base, vitest)
- [ ] `packages/protocol`: tipos y esquemas zod
  - [ ] `PermissionLevel`, `Provenance`, `TaskType`, `Usage`
  - [ ] `ModelCapabilities`, `RoutingDecision` (con `propensity`)
  - [ ] `Verdict` + regla de escalado (`uncertain` ≠ éxito)
  - [ ] `ToolDescriptor`, `PolicyDecision`
  - [ ] `OrchestratorEvent` (unión discriminada, fuente única para UI y telemetría)
  - [ ] `ExecutionTrace` (esquema del dataset de investigación)
  - [ ] Tests de validación
- [ ] **Demo visual mínima** (`apps/desktop`)
  - [ ] Reducer puro `eventos → estado de la isla` (con tests)
  - [ ] Isla colapsada/expandida con Framer Motion
  - [ ] Cuervo SVG con estados: idle, listening, thinking, success, error, warning
  - [ ] Reproductor de escenarios sobre el protocolo, **etiquetado "DEMO"** (no pasa por progreso real)
  - [ ] Prompt de permiso interactivo (permitir/denegar reanuda el escenario)
  - [ ] Escenarios: acción local sin LLM, modelo barato, escalado con permiso
  - [ ] Captura de pantalla de verificación
- [ ] Shell Tauri (`src-tauri`): ventana transparente, siempre encima, sin decoración
  - [ ] Esqueleto escrito
  - [ ] **Validado en Windows** ← requiere máquina Windows del usuario
- [ ] ADRs en `docs/adr/`
  - [ ] 0001 Monorepo y límites de paquetes
  - [ ] 0002 Sidecar TypeScript + shell Tauri fino; IPC local con token
  - [ ] 0003 Abstracción de proveedores y `ModelCapabilities`
  - [ ] 0004 `OrchestratorEvent` como flujo único (UI + telemetría)
  - [ ] 0005 Policy engine determinista fuera del LLM; taint tracking
  - [ ] 0006 Esquema de traza con `propensity` para evaluación off-policy
  - [ ] 0007 SQLite + sqlite-vec en MVP (Postgres diferido)
- [ ] `CLAUDE.md` en la raíz que apunta a estos documentos

### Criterio de salida
1. `pnpm typecheck` y `pnpm test` en verde.
2. La demo corre con `pnpm dev` y muestra los tres escenarios.
3. Spike de overlay probado en Windows (transparencia, click-through, pantalla completa, DPI) o
   decisión documentada de pasar a Electron.

### Riesgos abiertos de la fase
- No hay Windows en el entorno de desarrollo remoto: el spike de overlay lo debe ejecutar el usuario.

---

## Fase 1 — Columna vertebral (3–4 semanas) ⬜
- [ ] Orquestador: máquina de estados de tarea + bus de eventos
- [ ] Registro de proveedores + adaptadores Anthropic, OpenRouter, Ollama
- [ ] Intent router local (reglas + clasificador pequeño)
- [ ] Registro de herramientas (archivos, apps, portapapeles) con `ToolDescriptor`
- [ ] Policy engine (4 niveles, confirmación, taint, log de auditoría)
- [ ] Sidecar + IPC con token; la demo pasa de escenarios a eventos reales
- [ ] Telemetría persistida (SQLite)

## Fase 2 — Router y evaluador (3 semanas) ⬜
- [ ] Estrategias de router intercambiables (siempre-premium, siempre-barato, reglas)
- [ ] Filtrado por capacidades (visión, herramientas, contexto, sensibilidad de datos)
- [ ] Evaluador de código (tests) y de postcondición de herramientas
- [ ] Escalado con checkpoints (snapshot / dry-run / plan→aprobación)
- [ ] Contabilidad de costo incluyendo costo del evaluador
- [ ] ADR: cascada vs ruteo predictivo

## Fase 3 — Arnés de experimento (3 semanas) ⬜
- [ ] Suite de tareas con ground truth (HumanEval/MBPP, subconjunto SWE-bench-Lite, QA, tareas propias ES/EN)
- [ ] **Tabla contrafactual**: cada modelo × cada tarea, una vez
- [ ] Simulador de replay offline
- [ ] Baselines: A premium, B barato, C reglas, oráculo, tipo RouteLLM
- [ ] Primer análisis (Pareto, IC por bootstrap pareado)

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
