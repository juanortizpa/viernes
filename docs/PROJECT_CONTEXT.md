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

**Decidido (2026-10-04): es un producto personal**, no una tesis con fecha límite. Ante conflicto, gana la utilidad diaria;
el experimento de ruteo sigue siendo el diferenciador técnico, pero sin plazo. Restricción dura: **100 % gratis** (APIs gratuitas
+ las suscripciones Claude Pro y Gemini del usuario, usadas a través de sus CLIs locales). Idioma: **solo español**.
Uso: asistente general con foco en programar; la capacidad de programar se aprovecha para manejar las demás apps.

## 3. Arquitectura (separación de responsabilidades que debe mantenerse)

```text
UI (Isla + Cuervo) / Voz
        │  (eventos)
   ORQUESTADOR ── Intent Router (sin LLM) · Capa inmediata (acuse/caché, ADR-0015) · Model Router · Policy Engine
        │
   Evaluador ── éxito → fin / fallo → escalar
        │
   Registro de herramientas (MCP como adaptador en el borde, ADR-0025 · web con guarda de egreso, ADR-0028)
        │
   Memoria (SQLite: conversación en RAM + recuerdos explícitos, ADR-0023; sqlite-vec solo con un embedding semántico real; Postgres/pgvector en V2)
```

Reglas duras:
- El router depende de `ModelCapabilities`, **nunca** de paquetes de proveedor.
- Añadir un proveedor no exige tocar el orquestador.
- El LLM **propone**, el Policy Engine (código determinista, fuera del modelo) **decide**.
- La UI solo renderiza progreso derivado de `OrchestratorEvent`. **Nunca progreso falso.**
- Credenciales: nunca como memoria normal, nunca en texto plano al LLM (referencias, V2).
- La capa inmediata (ADR-0015) es determinista, tiene lista de exclusión (tiempo, estado, herramientas, datos sensibles),
  se etiqueta como `source: instant` y nunca se mezcla con las métricas de los modelos.
- Una tarea que leyó contenido no confiable solo envía datos (p. ej. `web.fetch`) a direcciones que ya vio o que escribió el usuario;
  cualquier otra pide confirmación (ADR-0028). Los servidores MCP nunca reciben las claves de JARVIS (ADR-0025).
- Una ejecución especulativa (antes de que el usuario termine de hablar) no cambia nada del mundo ni de la memoria hasta que las
  palabras finales la confirman; si no, se descarta sin rastro (ADR-0029). Las muletillas solo describen recepción o lo que
  realmente arranca, nunca resultados.
- La memoria de largo plazo solo se escribe por petición explícita del usuario; el modelo puede leerla pero ninguna herramienta
  que edite datos del usuario se le ofrece (`modelCallable: false`, ADR-0023).
- Todo se registra en el esquema de traza (dataset de investigación), con `propensity` en cada decisión de ruteo.

## 4. Decisiones tecnológicas vigentes

| Tema | Decisión | Estado |
|---|---|---|
| Shell de escritorio | Tauri (spike de transparencia/click-through en Windows primero; fallback Electron). La isla usa el sidecar real (`island.bat`, ADR-0021), con clic que atraviesa por regiones, atajo global `Ctrl+Alt+Espacio`, bandeja e instancia única (ADR-0022) | corre en Linux; pendiente de validar en Windows |
| Núcleo | TypeScript como sidecar; Rust solo para OS (ventana, almacenamiento seguro, ciclo de vida del sidecar) | hecho (ADR-0008, ADR-0021) |
| IPC | NDJSON por stdio con token, sin puertos de red; en Tauri el shell relaya stdio por un `Channel` (ADR-0021); el navegador usa el puente solo-dev de Vite | hecho |
| UI | React + TypeScript + Framer Motion | propuesto |
| Almacenamiento MVP | SQLite + sqlite-vec detrás de una interfaz (Postgres en V2/sync) | propuesto |
| Herramientas | Registro interno único; **cliente MCP por stdio** (riesgo lo decide el usuario, salida no confiable, entorno sin claves, ADR-0025); exponer JARVIS como servidor MCP: V2 | consumir hecho (probado contra el SDK oficial) |
| Web | `web.search` (DuckDuckGo HTML, sin cuenta) + `web.fetch` (solo direcciones públicas) + guarda de egreso en el policy engine; preguntas «de hoy» exigen modelo con herramientas y el prompt lleva la fecha (ADR-0028) | hecho; probado en vivo |
| Rutinas | Nombre → órdenes locales en orden, sin modelo, policy por paso; «¿qué podés hacer?» desde la config viva (ADR-0027) | hecho |
| Proveedores MVP | Anthropic + OpenRouter + Ollama (3 adaptadores para probar la abstracción) | propuesto |
| Respuesta inmediata | R1 plantillas ES/EN + acuse como evento (MVP); R2 caché semántico con embedding local <100 MB (V2); R3 perfil de estilo por contadores, sin modelo propio (ADR-0015) | propuesto |
| Memoria | Conversación en RAM (últimos turnos, 20 min) + recuerdos explícitos («recuerda que…») en SQLite, recuperación por palabras con presupuesto; el modelo lee, nunca escribe (ADR-0023) | hecho; huecos semánticos pendientes |
| Latencia | Streaming de voz con parciales, especulación (eventos retenidos, herramientas en espera hasta confirmar), cierre de turno semántico, voz por frases, `ModelHealth` (enfriamiento + EWMA de primer token), herramientas por petición, muletillas según latencia predicha (ADR-0029) | hecho; medido con grabaciones reales; sin micrófono real |
| Voz | STT: carrera Groq whisper + Gemini (entiende lo que quisiste decir) con whisper local de respaldo (ADR-0020); push-to-talk + STT local con whisper.cpp (binario y modelo del usuario, ADR-0016) hecho; TTS (ADR-0017) y wake word en dos etapas con tu voz + whisper tiny + ventana de 10 s (ADR-0018) implementados, **sin probar con voz real** | parcial |
| Programación | Delegar en los CLIs oficiales en vez de reimplementar el bucle agente: **Gemini CLI** (gratis) primero y **Claude Code** (plan Pro) si falla, se queda sin cuota o falla la comprobación del proyecto (`verify`). Herramienta `code.agent` sensible y con salida no confiable; orden "en el proyecto X, …" (ADR-0024). Puntos de restauración git por ejecución: «¿qué cambió el agente?», «deshacé los cambios» (ADR-0026) | Gemini probado en real; Windows y Claude sin probar; deshacer probado en Windows con repos reales |

## 5. Niveles de permiso

🟢 READ · 🟡 REVERSIBLE · 🟠 SENSITIVE · 🔴 CRITICAL (confirmación explícita siempre).
Contenido de origen no confiable (web, archivos, correos) marca la cadena como *tainted*: no puede
disparar SENSITIVE/CRITICAL sin confirmación.

## 6. MVP vs V2 vs Investigación

- **MVP-0 (spine, texto primero):** barra de comandos + isla mínima (3 estados) + proveedores +
  intent router local + registro de herramientas + policy engine + router v1 + evaluador de código +
  escalado con checkpoints + telemetría completa.
- **MVP-0.5 (respuesta inmediata R1–R3, hecho):** saludos por reglas, acuse rápido, caché semántico de respuestas verificadas y perfil de estilo (ADR-0015).
- **MVP-1:** memoria (conversación + recuerdos explícitos hechos, ADR-0023), router aprendido (bandit), panel AI Economy, animaciones del cuervo.
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
