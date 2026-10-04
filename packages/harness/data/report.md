# Informe del arnés (15 tareas completas, 28 descartadas por celdas faltantes)

Línea base: `A_always_premium`. Intervalos: bootstrap pareado sobre tareas, 95%. Los costos usan los precios supuestos de abajo, no costos medidos.

## Modelos (una pasada por tarea)
| Modelo | Éxito | Costo medio | Latencia media |
|---|---|---|---|
| liquid/lfm-2.5-2.6b:free | 100.0% | $0.000008 | 737 ms |
| qwen/qwen3.8-27b:free | 100.0% | $0.000051 | 1033 ms |
| nvidia/nemotron-3-super-120b-a12b:free | 100.0% | $0.000077 | 826 ms |
| nvidia/nemotron-3-ultra-550b-a55b:free | 100.0% | $0.000300 | 2001 ms |

## Políticas
| Política | Éxito | Δ éxito vs base | Costo medio | Ahorro vs base | Escalado | Frontera |
|---|---|---|---|---|---|---|
| A_always_premium | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000300 | 0.0% [0.0%, 0.0%] | 0.0% |  |
| B_always_cheapest | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000008 | 97.3% [96.2%, 98.4%] | 0.0% | sí |
| C_rules | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000008 | 97.3% [96.2%, 98.4%] | 0.0% | sí |
| oracle | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000008 | 97.3% [96.2%, 98.4%] | 0.0% | sí |
| cascade_heuristic | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000008 | 97.3% [96.2%, 98.4%] | 0.0% | sí |
| cascade_ground_truth | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000008 | 97.3% [96.2%, 98.4%] | 0.0% | sí |
| learned_cv_simplified | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000008 | 97.3% [96.2%, 98.4%] | 0.0% | sí |

## Evaluador heurístico vs ground truth (todas las celdas)
Acepta y era correcta: 60 · acepta pero era incorrecta (falso positivo): 0 · rechaza y era correcta (escalado inútil): 0 · rechaza y era incorrecta: 0

## Precios supuestos (USD por 1M tokens)
- liquid/lfm-2.5-2.6b:free: entrada 0.02, salida 0.04
- qwen/qwen3.8-27b:free: entrada 0.1, salida 0.4
- nvidia/nemotron-3-super-120b-a12b:free: entrada 0.3, salida 1
- nvidia/nemotron-3-ultra-550b-a55b:free: entrada 0.9, salida 3
