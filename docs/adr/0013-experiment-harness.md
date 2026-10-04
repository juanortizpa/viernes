# ADR-0013: Arnés de experimento (tabla contrafactual + replay offline)

**Estado:** aceptado · 2026-10-04 (primer corte, Fase 3)

## Contexto
La tesis necesita comparar políticas de ruteo (siempre-premium, siempre-barato, reglas, cascada, oráculo)
sobre **las mismas tareas** sin volver a llamar a las APIs cada vez que cambiamos una política, un
evaluador o un precio. ADR-0006 ya fijó la idea (tabla contrafactual); este ADR fija cómo se construye.

## Decisión
Paquete `@jarvis/harness` (no depende de ninguna app).

1. **Ground truth determinista, sin juez LLM.** Cada tarea trae un `Check`: `exact`, `contains_all`, `regex`,
   `number` o `code_tests`. Cada tarea trae además una `reference` que debe pasar su propio check; un test
   lo verifica para toda la suite, así los errores de ground truth se detectan antes de gastar llamadas.
2. **`code_tests` corre en un proceso Node con `--permission`**: sin lectura fuera del directorio temporal, sin
   procesos hijos ni workers, entorno vacío, timeout de 10 s. **No aísla la red** (Node 22 no tiene
   `--allow-net`). Vale para prompts de benchmark; **no** es el sandbox que necesitaría una herramienta del
   asistente que ejecute código arbitrario del usuario.
3. **Tabla contrafactual** = JSONL append-only con una celda por (tarea, modelo): respuesta, veredicto,
   **tokens** y latencia. Se guardan tokens, no costo: los precios son un supuesto que se aplica al analizar
   (`--prices`), de modo que cambiar precios o el evaluador no requiere nuevas llamadas. La corrida es
   reanudable. Un error de transporte (429/5xx tras reintentos con backoff) se guarda como celda con
   `error`; **no cuenta como evidencia del modelo**, se reintenta en la siguiente corrida y las tareas con
   celdas faltantes se excluyen del análisis (casos completos, reportando cuántas se descartan).
   Las cuotas diarias (OpenRouter gratis: 50 peticiones/día) **detienen la corrida limpiamente** (no se
   reintentan ni dejan celda), `--budget N` limita las llamadas por invocación, y las tareas se recorren en
   orden aleatorio con semilla para que una corrida cortada no sea solo la cabeza fácil de la suite.
4. **El replay reutiliza código de producción**: `routeRequestFor`, `RulesRouter`/cualquier `ModelRouter`,
   `escalationLadder` y `ResponseHeuristicEvaluator`. Lo que se mide es el sistema real, no una copia.
5. **Políticas:** A siempre-premium · B siempre-barato · C reglas · cascada (evaluador heurístico real) ·
   cascada con evaluador perfecto (cota superior de cualquier evaluador) · oráculo (el más barato que
   acierta) · `learned_cv_simplified` (por tipo de tarea, validación cruzada k-fold). Esta última **no** es
   RouteLLM (no hay factorización de matrices ni datos de preferencia); solo marca la familia "predecir sin
   escalar". El baseline real de Fase 6 lo reemplaza.
6. **Estadística:** bootstrap pareado sobre tareas (mismos índices para todas las políticas), IC 95 %,
   semilla fija. Se reportan Δ de éxito y ahorro de costo frente a la línea base A, frontera de Pareto y la
   calibración del evaluador heurístico contra el ground truth (falsos positivos / escalados inútiles).
7. **Éxito de una política** = ground truth de la respuesta finalmente entregada. En cascada se pagan todos
   los intentos (costo y latencia suman).

## Limitaciones conocidas (no esconderlas en los resultados)
- Una sola muestra por celda: no captura la varianza de muestreo del modelo.
- Suite semilla pequeña (43 tareas, propias ES/EN): los intervalos son anchos; sirve para validar la
  maquinaria y dar una primera señal, no para concluir.
- Con modelos gratuitos el costo real es 0; el ahorro se calcula con **precios de referencia supuestos**
  (`prices.free-reference.json`, escalados por tamaño). La frontera depende de esos supuestos.
- Con datos parciales las tareas completas pueden no ser una muestra aleatoria; el informe lo advierte. Con éxito
  0 % o 100 % el bootstrap da intervalos de ancho cero, que no significan certeza.
- Los tier gratuitos tienen límites de tasa y latencias que no representan producción.
- El replay supone determinismo: reintentar el mismo modelo no se modela.
- HumanEval/MBPP (Python) y SWE-bench-Lite requieren un sandbox real (contenedor); diferido. El cargador
  de datasets externos tampoco existe aún.

## Consecuencias
+ Cambiar políticas, evaluadores o precios cuesta cero llamadas. + La suite se autovalida.
− Hay que mantener el arnés alineado con el orquestador (por eso comparten funciones, no copias).
