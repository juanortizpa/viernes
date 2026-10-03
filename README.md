# JARVIS

Capa operativa de IA personal, adaptativa y multimodelo para Windows. El corazón del proyecto es el
ruteo dinámico de modelos: usar el más barato capaz de resolver la tarea y escalar solo si hace falta.

- Contexto y reglas: [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)
- Fases y seguimiento: [docs/ROADMAP.md](docs/ROADMAP.md)
- Decisiones técnicas: [docs/adr/](docs/adr/)
- Spike del overlay (Windows): [docs/SPIKE_OVERLAY.md](docs/SPIKE_OVERLAY.md)

## Ver la demo visual

```bash
pnpm install
pnpm dev        # http://localhost:5173
```

Elige un escenario (acción local, modelo barato, escalado con permiso). La isla y el cuervo solo
muestran lo que llega como `OrchestratorEvent`. Por ahora son escenarios guionados (etiquetados "DEMO");
en la Fase 1 la fuente pasará a ser el orquestador real.

## Verificación

```bash
pnpm typecheck
pnpm test
```
