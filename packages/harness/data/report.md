# Informe del arnés (43 tareas completas)

Línea base: `A_always_premium`. Intervalos: bootstrap pareado sobre tareas, 95%. Los costos usan los precios supuestos de abajo, no costos medidos.

## Modelos (una pasada por tarea)
| Modelo | Éxito | Costo medio | Latencia media |
|---|---|---|---|
| openai/gpt-oss-20b | 97.7% | $0.000041 | 711 ms |
| qwen/qwen3.8-27b | 86.0% | $0.000023 | 588 ms |
| openai/gpt-oss-120b | 100.0% | $0.000114 | 599 ms |
| gemma-4-26b-a4b-it | 100.0% | $0.000119 | 8553 ms |
| gemma-4-31b-it | 100.0% | $0.000129 | 39741 ms |
| gemini-3.1-flash-lite | 100.0% | $0.000017 | 1229 ms |
| gemini-3.5-flash-lite | 100.0% | $0.000064 | 641 ms |

## Políticas
| Política | Éxito | Δ éxito vs base | Costo medio | Ahorro vs base | Escalado | Frontera |
|---|---|---|---|---|---|---|
| A_always_premium | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000064 | 0.0% [0.0%, 0.0%] | 0.0% |  |
| B_always_cheapest | 97.7% [93.0%, 100.0%] | -2.3% [-7.0%, 0.0%] | $0.000041 | 36.2% [12.1%, 49.5%] | 0.0% |  |
| C_rules | 97.7% [93.0%, 100.0%] | -2.3% [-7.0%, 0.0%] | $0.000061 | 4.4% [-17.9%, 24.4%] | 0.0% |  |
| oracle | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000017 | 73.2% [65.3%, 80.1%] | 0.0% | sí |
| cascade_heuristic | 97.7% [93.0%, 100.0%] | -2.3% [-7.0%, 0.0%] | $0.000041 | 36.2% [12.1%, 49.5%] | 0.0% |  |
| cascade_ground_truth | 100.0% [100.0%, 100.0%] | 0.0% [0.0%, 0.0%] | $0.000041 | 35.2% [10.8%, 49.0%] | 2.3% |  |
| learned_cv_simplified | 97.7% [93.0%, 100.0%] | -2.3% [-7.0%, 0.0%] | $0.000042 | 33.2% [6.7%, 47.7%] | 0.0% |  |

## Evaluador heurístico vs ground truth (todas las celdas)
Acepta y era correcta: 294 · acepta pero era incorrecta (falso positivo): 7 · rechaza y era correcta (escalado inútil): 0 · rechaza y era incorrecta: 0

## Precios supuestos (USD por 1M tokens)
- openai/gpt-oss-20b: entrada 0.05, salida 0.2
- qwen/qwen3.8-27b: entrada 0.1, salida 0.4
- openai/gpt-oss-120b: entrada 0.15, salida 0.6
- gemma-4-26b-a4b-it: entrada 0.08, salida 0.3
- gemma-4-31b-it: entrada 0.12, salida 0.45
- gemini-3.1-flash-lite: entrada 0.1, salida 0.4
- gemini-3.5-flash-lite: entrada 0.25, salida 1
