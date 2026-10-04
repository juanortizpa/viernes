# JARVIS

Capa operativa de IA personal, adaptativa y multimodelo para Windows. El corazón del proyecto es el
ruteo dinámico de modelos: usar el más barato capaz de resolver la tarea y escalar solo si hace falta.

- Contexto y reglas: [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)
- Fases y seguimiento: [docs/ROADMAP.md](docs/ROADMAP.md)
- Decisiones técnicas: [docs/adr/](docs/adr/)
- Spike del overlay (Windows): [docs/SPIKE_OVERLAY.md](docs/SPIKE_OVERLAY.md)

## Ver la demo visual

### Local

```bash
pnpm install
pnpm dev        # http://localhost:5173
```

### GitHub Codespace

```bash
pnpm install
pnpm dev
```

Codespace expondrá automáticamente el puerto 5173 y creará una URL pública (ej: `https://<usuario>-<repo>-<random>.github.dev:5173/`). Haz clic en la notificación de "Forwarded Ports" o abre la pestaña "Ports" en el terminal.

`pnpm dev` también arranca el sidecar real (solo en desarrollo): escribe una orden en la caja
(«qué hora es?», «abre vscode», «hola») y la isla muestra eventos reales del orquestador. Sin proveedor de IA
configurado, las respuestas del modelo son un eco offline claramente etiquetado. Para usar uno real,
copia `jarvis.config.example.json` a `jarvis.config.json` (y exporta `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`
si aplica).

Los escenarios guionados siguen disponibles (acción local, modelo barato, escalado con permiso). Van etiquetados "DEMO":
no ejecutan nada real. La isla y el cuervo solo muestran lo que llega como `OrchestratorEvent`, venga del
escenario o del sidecar.

## Verificación

```bash
pnpm typecheck
pnpm test
```
