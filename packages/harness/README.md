# @jarvis/harness

Arnés de experimento (ADR-0013): tabla contrafactual modelo × tarea y simulador de políticas offline.

```bash
export OPENROUTER_API_KEY=...            # NODE_USE_ENV_PROXY=1 si hay proxy
# 1. Llenar la tabla (reanudable; --budget limita llamadas, p. ej. 45 por día en el tier gratis)
pnpm --filter @jarvis/harness harness run --config harness.config.free.json --table data/counterfactual.jsonl --budget 45
# 2. Analizar sin llamar a ninguna API (se puede repetir con otros precios/evaluadores)
pnpm --filter @jarvis/harness harness report --config harness.config.free.json --table data/counterfactual.jsonl \
  --prices prices.free-reference.json --out data/report.md
```

- `prices.free-reference.json` son precios **supuestos** (escalados por tamaño): con modelos gratis el costo real es 0.
- Se niega a usar modelos con precio salvo `--allow-paid`.
- `data/counterfactual.jsonl` se versiona: es el dataset, y permite reproducir el informe sin APIs.
