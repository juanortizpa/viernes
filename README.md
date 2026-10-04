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
copia `jarvis.config.example.json` a `jarvis.config.json` (y exporta `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY`
si aplica).

Los escenarios guionados siguen disponibles (acción local, modelo barato, escalado con permiso). Van etiquetados "DEMO":
no ejecutan nada real. La isla y el cuervo solo muestran lo que llega como `OrchestratorEvent`, venga del
escenario o del sidecar.

## Probar en Windows

> **Guía con resultados esperados: [docs/WINDOWS_TESTING.md](docs/WINDOWS_TESTING.md).** Atajo: doble clic en `setup.bat` (instala todo, incluida la voz) y luego en `start.bat`.

Requisitos: Git, **Node 22.13 o superior** (el almacén de trazas usa `node:sqlite`), pnpm 10 (`corepack enable`).
Para el shell Tauri además: Rust (MSVC) y WebView2 (ver [docs/SPIKE_OVERLAY.md](docs/SPIKE_OVERLAY.md)).

```powershell
git clone https://github.com/juanortizpa/viernes.git
cd viernes
pnpm install
pnpm typecheck; pnpm test
```

**Demo con el sidecar real** (funciona hoy, en el navegador):

```powershell
copy jarvis.config.openrouter.example.json jarvis.config.json
$env:OPENROUTER_API_KEY = "<tu clave>"    # no la subas al repo; jarvis.config.json ya está en .gitignore
$env:JARVIS_DATA_DIR = "$PWD\.jarvis"       # trazas persistidas en .jarvis\traces.db
pnpm dev                                    # http://localhost:5173
```

Prueba «qué hora es?» (intent local, sin modelo), «hola» (modelo) y «usa tu herramienta de hora» (el modelo pide una herramienta).

**Sidecar empaquetado:** `pnpm --filter @jarvis/sidecar build` genera `apps/sidecar/dist/sidecar.mjs` (corre con `node`).

**Isla flotante (Tauri)**: doble clic en `island.bat` (o `node scripts/island.mjs`). El shell lanza el sidecar real y lo
conecta a la isla por stdio ([ADR-0021](docs/adr/0021-tauri-sidecar-relay.md)): órdenes, voz, economía y permisos, sin navegador.
La primera vez compila la isla (necesita Rust, varios minutos); después arranca en un segundo y solo recompila si cambió el código.
Fuera de la isla los clics pasan a las apps de abajo; **Ctrl+Alt+Espacio** (mantener) habla desde cualquier app; ⚙ abre los ajustes de voz;
el icono de la bandeja la oculta o la cierra ([ADR-0022](docs/adr/0022-overlay-click-through-shortcut-tray.md)).
`island.bat --dev` usa `tauri dev` con recarga en caliente. Probado en Linux; **sin probar en Windows** (ver [docs/SPIKE_OVERLAY.md](docs/SPIKE_OVERLAY.md)).

Pruebas contra la API real (opcional, gasta fracciones de centavo): `$env:JARVIS_LIVE = "1"; pnpm test`.

## Verificación

```bash
pnpm typecheck
pnpm test
```

## Cliente Python de OpenRouter (auxiliar)

`openrouter_client.py`, sin dependencias, para pruebas rápidas desde terminal. Requiere `OPENROUTER_API_KEY`. El adaptador real del proyecto está en `packages/providers`.
