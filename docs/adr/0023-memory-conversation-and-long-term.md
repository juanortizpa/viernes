# ADR-0023: Memoria — conversación (corto plazo) y recuerdos explícitos (largo plazo)

**Estado:** aceptado · 2026-10-04 · Fase 5 (primer corte)

## Contexto
Uso real en Windows: «¿quién ganó el mundial?» → el asistente preguntó «¿masculino o femenino?» → «masculino» → respondió
«¿qué quieres hacer con la palabra masculino?». Cada orden era una tarea aislada: el modelo nunca veía el turno anterior.
Reproducido con Groq real antes del cambio («¿En qué contexto necesitas ayuda con "masculino"?») y corregido después
(«la Copa del Mundo 2022 la ganó Argentina…»).

La Fase 5 pide además memoria de largo plazo con control del usuario y recuperación **medida**. Los cuatro tipos de memoria
del plan quedan así: **factual y de preferencias** (este ADR), **conductual** = perfil de estilo por contadores (ADR-0015, R3),
**operacional** = alias de apps aprendidos (ADR-0010).

## Decisión

### M1 — Memoria de conversación (`ConversationMemory`)
- Los últimos intercambios (por defecto 8, ≤ 6 000 caracteres) van al modelo como mensajes previos. **Solo en RAM**, nunca en
  disco; se olvida tras 20 min sin actividad, con «olvida esta conversación» / «empecemos de nuevo», o al reiniciar el sidecar.
- **Seguimiento** (`isFollowUp`): el asistente acaba de preguntar algo, o el mensaje tiene 1–2 palabras, o empieza como
  continuación («y en python?», «otro», «explica eso»). Un seguimiento: (a) **se clasifica junto con la pregunta que responde**
  («masculino» no es una pregunta trivial para el modelo más barato), (b) **nunca** se sirve desde la caché ni se aprende en ella.
  Una pregunta corta pero completa («¿quién ganó el mundial?») no es seguimiento: medido en la UI real, la primera versión
  (≤ 4 palabras) le pegaba la pregunta anterior y recuperaba un recuerdo ajeno.
- No se guardan intercambios con secretos (`detectSensitive`, en cualquiera de los dos lados). Una respuesta construida con
  contenido externo no confiable se guarda como `[respuesta omitida…]`: una inyección en una web no viaja a los turnos siguientes.
- Fallos y cancelaciones no entran; las acciones locales sí (con su resumen); los comandos de memoria y el propio «olvida esta
  conversación» no.
- **Olvidar un recuerdo (o borrar la memoria) también olvida la conversación en curso**, y lo dice: si no, la frase «recuerda
  que…» de hace un minuto, o una respuesta que la usó, seguiría en el contexto y el modelo la «sabría» hasta 20 minutos más.
  Vale también para el ✕ del panel (su resumen muestra que la conversación quedó sin contexto).

### M2 — Recuerdos de largo plazo (`MemoryBook`, SQLite `memory.db`)
- **Solo se escribe por petición explícita del usuario**, con reglas deterministas: «recuerda que…», «acuérdate de que…»,
  «anota que…», «memoriza…», «remember that…». «Guarda el archivo», «recuerda abrir paint» o «recuérdame…» **no** son recuerdos.
- **El modelo puede leer, nunca escribir.** Nueva bandera `Tool.modelCallable = false`: la herramienta no se ofrece al modelo y,
  si la pide igual, se le responde «unknown tool». Se aplica a `memory.*`, `conversation.clear` y, de paso, a todo lo que edita
  datos del usuario (`aliases.forget`, `instant.forget/clear/toggle`, `style.reset/toggle`). Motivo: una inyección de prompt no
  debe poder convertirse en una creencia permanente. La escritura propuesta por el modelo (con bandeja de revisión) es **V2**.
- Se rechaza lo que parezca contraseña, clave, tarjeta o IBAN; más de 300 caracteres; duplicados (misma idea reescrita); más de
  200 recuerdos (se avisa, no se borra nada en silencio).
- Dos clases: **preferencias** («prefiero…», «siempre…», «nunca…») se aplican **siempre** (presupuesto 400 caracteres);
  **datos** se recuperan solo si son relevantes (≤ 5, ≤ 700 caracteres). Se añaden al *system prompt* etiquetados como datos del
  usuario, no instrucciones del sistema.
- **Recuperación por palabras compartidas** (sin modelo): cada palabra en común es una pista; una palabra temática («gato»,
  «hermana», «Bogotá») vale 0,85, una de marco («se llama», «favorito») 0,3, y las de situación («vivo», «trabajo») 0,6 si la
  pregunta habla del usuario. Las pistas se combinan como independientes. Sin números sueltos, erratas solo en palabras de ≥ 7
  letras, verbos auxiliares fuera. El embedding de n-gramas solo desempata.
- Si se usa memoria (o es un seguimiento), la respuesta **no** se sirve de la caché ni se aprende en ella.
- **Control del usuario:** «qué recuerdas de mí», «olvida que…» (si la descripción encaja con varios, no borra nada y pregunta
  cuál), «borra toda mi memoria» (pide confirmación: riesgo `sensitive`), «desactiva/activa la memoria». Panel **Memoria** en la
  isla (⚙) y en el navegador: cada recuerdo con su tipo y cuántas veces se usó, ✕ para olvidarlo, borrar todo con doble clic.
- **Veracidad en la UI:** evento nuevo `context.used` (cuántos turnos y **ids** de recuerdos, nunca su texto), emitido solo si
  algo entró de verdad en el prompt; la isla muestra «🧠 2 recuerdos · 💬 contexto: 3». La traza guarda los conteos
  (`ExecutionTrace.context`) para medir el efecto de la memoria.

## Medido

### Recuperación (`harness memory-eval`, sin red, corpus propio)
Perfil inventado de 29 datos + 4 preferencias; 33 consultas que necesitan un recuerdo (4 «huecos semánticos» sin palabras en
común) y 46 que no (6 «negativas difíciles» que usan la palabra de un recuerdo en otro sentido). El corpus se escribió antes de
mirar puntuaciones; las consultas alternan entre **desarrollo** (para elegir) y **prueba retenida** (solo para informar).

| Estrategia | Recupera (dev / prueba) | Falsa inyección (dev / prueba) | Caracteres por consulta |
|---|---|---|---|
| Toda la memoria siempre | 100 % / 100 % | 100 % / 100 % | 1 393 |
| Los 3 mejores siempre | 88 % / 94 % | 100 % / 100 % | ~125 |
| Solo embedding de n-gramas (≥ 0,35) | 41 % / 25 % | 4 % / 0 % | ~8 |
| **Producción (palabras)** | **88 % / 94 %** | **17 % / 17 %** | **~25** |

En consultas normales (sin las difíciles): **100 % recuperadas, 91 % de precisión, 5 % de falsa inyección**. La falsa inyección
restante son homónimos («plan» de datos vs. plan de fin de semana, «Nacional» del equipo y de la universidad, «español»).
El embedding de n-gramas **no sirve** para esto (mide parecido de redacción, no de tema): queda como desempate.

### Ablación con modelo real (`harness memory-ablation`, Groq, 2 muestras por pregunta)
Perfil de 29 datos; 22 preguntas (14 que necesitan un dato guardado, 3 huecos semánticos o entre idiomas, 5 de conocimiento general) × 2 muestras × 2 modelos. Comprobación determinista del texto (sin juez LLM), con lo que solo
la memoria sabe («avena», «martes», «Sofía», no «6 a. m.» ni «sin azúcar», que se aciertan por suerte). En las 5 preguntas de
conocimiento general se mide además si la respuesta menciona algo de la memoria sin venir al caso («fuga»).

| Brazo | gpt-oss-20b: dato guardado | huecos | general correcto | fugas | tokens de entrada | gpt-oss-120b: dato guardado | huecos | general | fugas | tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| A · sin memoria | 0/28 | 0/6 | 6/6 | 0/10 | 132 | 0/28 | 1/6* | 6/6 | 0/10 | 132 |
| **B · producción** | **28/28** | 1/6* | 6/6 | **0/10** | **157** | **28/28** | 0/6 | 6/6 | **0/10** | **157** |
| C · toda la memoria | 28/28 | 6/6 | 6/6 | 0/10 | 536 | 28/28 | 6/6 | 6/6 | 0/10 | 722 |

\* Aciertos por suerte: una lista genérica de lenguajes que menciona Python y TypeScript.

Lectura: la recuperación da **todo** el beneficio de la memoria en las preguntas con palabras en común (0 → 28/28) por **+25
tokens** de media, frente a +400–590 de meterla entera; ese costo de C crece con cada recuerdo y el de B no. Lo que B no
cubre son exactamente los huecos semánticos y entre idiomas (0/6), que C sí resuelve. Ninguna variante filtró recuerdos en
respuestas generales. Muestra pequeña (n=2 por pregunta, temperatura por defecto del proveedor); datos en
`packages/harness/data/memory-ablation.json`.

Errores de medición encontrados y corregidos antes de dar estos números: (1) espacios no separables en las respuestas hacían
fallar patrones correctos («San José»); (2) varias comprobaciones se aprobaban por suerte sin memoria; (3) un fallo real de
recuperación («estoy») descrito abajo.

## Límites conocidos (y qué haría falta)
- **Huecos semánticos y entre idiomas:** «¿puedo pedir ceviche?» no encuentra «alérgico a los mariscos»; una pregunta en español
  no encuentra un recuerdo escrito en inglés. Ninguna variante barata lo resuelve; haría falta un embedding neuronal multilingüe
  local (~100 MB) o reordenar con un LLM (costo y latencia en cada consulta). Se reconsidera con datos de uso real.
- **Un recuerdo equivocado no es inocuo:** antes de quitar los verbos auxiliares, «¿para qué **estoy** entrenando?» recuperaba
  «**Estoy** construyendo… JARVIS» y el modelo inventó la respuesta. Por eso la precisión importa tanto como la recuperación.
- Contradicciones («mi hermana se llama Ana» y luego «… Laura»): se guardan ambas; el usuario ve las dos en el panel. Fusionar
  o actualizar es V2.
- La conversación vive en el sidecar: recargar la isla o reiniciar la empieza de cero (se considera correcto para privacidad).
- Las preferencias, al aplicarse siempre, desactivan en la práctica la caché de respuestas (ADR-0015) mientras existan.
- Los recuerdos relevantes viajan al modelo que responde (si es en la nube, salen del equipo); el panel lo dice.

## Alternativas descartadas
- Que el modelo decida qué recordar (herramienta de escritura o extracción automática): riesgo de envenenamiento persistente y
  de guardar cosas que el usuario no quiso. V2, con revisión del usuario.
- Meter toda la memoria en cada consulta: medido arriba (tokens ×3–4 frente a la recuperación, y crece con cada recuerdo).
- sqlite-vec con un embedding (ADR-0007): sin un embedding semántico de verdad no aporta; el de n-gramas perdió contra las
  palabras compartidas. Se retoma junto con el embedding neuronal.
- Guardar la conversación en disco: no aporta para el caso de uso y crea un registro de todo lo hablado.
