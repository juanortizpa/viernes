# JARVIS — Contexto del proyecto

> Documento vivo. Es la fuente de verdad para retomar el proyecto en cualquier sesión.
> Seguimiento de fases: [ROADMAP.md](./ROADMAP.md). Decisiones: [adr/](./adr/).
> Última actualización: 2026-10-04

## 1. Qué es

JARVIS es una capa operativa de IA personal, adaptativa y multimodelo para Windows. Vive sobre
múltiples modelos, herramientas (MCP), memoria y el computador del usuario. Se siente como una
presencia persistente (isla flotante + cuervo), no como un chat web.

**Diferenciador central (y problema de investigación):** selección dinámica de modelo y escalado
según dificultad, costo, latencia, capacidades e historial. Usar el modelo más barato capaz de
resolver la tarea y escalar solo cuando haga falta. Las acciones simples locales ("abre VS Code")
no usan LLM.

**Pregunta de investigación:** ¿cómo reduce la selección y escalado dinámico de modelos el costo de
inferencia manteniendo la efectividad de las tareas en un agente personal multimodelo?

## 2. Dos cosas que no se deben confundir

| Producto | Tesis |
|---|---|
| Isla, cuervo, voz, PC control, memoria | Router, evaluador, escalado, telemetría |

La tesis no necesita la UI. Ante conflicto de tiempo, **gana la tesis** (pendiente de confirmar con
el usuario si hay fecha límite; ver "Preguntas abiertas" en ROADMAP).

## 3. Arquitectura (separación de responsabilidades que debe mantenerse)

```text
UI (Isla + Cuervo) / Voz
        │  (eventos)
   ORQUESTADOR ── Intent Router (sin LLM) · Capa inmediata (acuse/caché, ADR-0015) · Model Router · Policy Engine
        │
   Evaluador ── éxito → fin / fallo → escalar
        │
   Registro de herramientas (MCP como adaptador en el borde)
        │
   Memoria (SQLite + sqlite-vec en MVP; Postgres/pgvector en V2)
```

Reglas duras:
- El router depende de `ModelCapabilities`, **nunca** de paquetes de proveedor.
- Añadir un proveedor no exige tocar el orquestador.
- El LLM **propone**, el Policy Engine (código determinista, fuera del modelo) **decide**.
- La UI solo renderiza progreso derivado de `OrchestratorEvent`. **Nunca progreso falso.**
- Credenciales: nunca como memoria normal, nunca en texto plano al LLM (referencias, V2).
- La capa inmediata (ADR-0015) es determinista, tiene lista de exclusión (tiempo, estado, herramientas, datos sensibles),
  se etiqueta como `source: instant` y nunca se mezcla con las métricas de los modelos.
- Todo se registra en el esquema de traza (dataset de investigación), con `propensity` en cada decisión de ruteo.

## 4. Decisiones tecnológicas vigentes

| Tema | Decisión | Estado |
|---|---|---|
| Shell de escritorio | Tauri (spike de transparencia/click-through en Windows primero; fallback Electron) | pendiente de validar en Windows |
| Núcleo | TypeScript como sidecar; Rust solo para OS (ventana, almacenamiento seguro, ciclo de vida del sidecar) | propuesto |
| IPC | stdio / named pipe con token, sin puertos de red | propuesto |
| UI | React + TypeScript + Framer Motion | propuesto |
| Almacenamiento MVP | SQLite + sqlite-vec detrás de una interfaz (Postgres en V2/sync) | propuesto |
| Herramientas | Registro interno único; MCP como adaptador (consumir/exponer) | propuesto |
| Proveedores MVP | Anthropic + OpenRouter + Ollama (3 adaptadores para probar la abstracción) | propuesto |
| Respuesta inmediata | R1 plantillas ES/EN + acuse como evento (MVP); R2 caché semántico con embedding local <100 MB (V2); R3 perfil de estilo por contadores, sin modelo propio (ADR-0015) | propuesto |
| Voz | Push-to-talk + STT local con whisper.cpp (binario y modelo del usuario, ADR-0016) hecho; TTS (ADR-0017) y wake word en dos etapas con tu voz + whisper tiny + ventana de 10 s (ADR-0018) implementados, **sin probar con voz real** | parcial |

## 5. Niveles de permiso

🟢 READ · 🟡 REVERSIBLE · 🟠 SENSITIVE · 🔴 CRITICAL (confirmación explícita siempre).
Contenido de origen no confiable (web, archivos, correos) marca la cadena como *tainted*: no puede
disparar SENSITIVE/CRITICAL sin confirmación.

## 6. MVP vs V2 vs Investigación

- **MVP-0 (spine, texto primero):** barra de comandos + isla mínima (3 estados) + proveedores +
  intent router local + registro de herramientas + policy engine + router v1 + evaluador de código +
  escalado con checkpoints + telemetría completa.
- **MVP-0.5 (respuesta inmediata R1–R3, hecho):** saludos por reglas, acuse rápido, caché semántico de respuestas verificadas y perfil de estilo (ADR-0015).
- **MVP-1:** memoria, router aprendido (bandit), panel AI Economy, animaciones del cuervo.
- **MVP-2:** voz (push-to-talk + STT local ya hecho; TTS y wake word pendientes), consciencia de contexto.
- **V2:** bóveda de credenciales, visión, multiagente, proactividad, sync, grafo de conocimiento.
- **Investigación:** tabla contrafactual, brazos A–D + oráculo + baseline tipo RouteLLM, curva de
  aprendizaje, test de deriva.

## 7. Riesgos vigilados (resumen)

1. Evaluador: costo y sesgo del juez LLM; su costo cuenta en el total.
2. Escalado con efectos secundarios: exige checkpoints o plan→aprobación→ejecución.
3. Inyección de prompts vía herramientas: taint tracking en el policy engine.
4. Sesgo de datos de aprendizaje: exploración controlada con propensity registrada; no estacionariedad.
5. Cascada vs. ruteo predictivo: decisión explícita (ADR pendiente).
6. Overlay en Windows (WebView2): spike en Fase 0.
7. Caché semántico: un falso positivo responde otra pregunta; se mide con el arnés antes de activarlo y ante duda va al modelo.
8. Voz: el motor de STT real no está probado (solo stand-ins); un motor tipo Whisper alucina en silencio, por eso hay una puerta de silencio previa.
9. Alcance: voz y pulido de UI no deben consumir el tiempo del experimento.

## 8. Cómo trabajar (reglas para Claude y para el equipo)

- Actuar como arquitecto senior: **cuestionar** ideas que añadan complejidad, riesgo, latencia o costo.
- Distinguir siempre MVP / V2 / Investigación.
- Primero contratos e interfaces, luego implementación incremental. Sin archivos gigantes.
- Evitar: proveedores hardcodeados, shell sin restricciones, secretos en texto plano, microservicios
  prematuros, funciones de IA falsas, progreso falso.
- Cada decisión técnica relevante → un ADR corto en `docs/adr/`.
- Al terminar un trabajo: actualizar `ROADMAP.md` (checklist, estado, registro de cambios).
- Los números de ahorro deben tener una línea base definida (p. ej. siempre-premium sobre las mismas tareas).

## 9. Idioma

Conversación y documentación en español; identificadores de código, comentarios técnicos y nombres de
tipos en inglés.
