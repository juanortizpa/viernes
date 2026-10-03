# ADR-0002: Núcleo TypeScript como sidecar y shell Tauri delgado

**Estado:** propuesto (pendiente del spike en Windows) · 2026-10-03

## Contexto
El shell necesita ventana transparente, siempre encima y acceso al SO. El núcleo (orquestador, router,
proveedores, MCP) se apoya en SDKs que son TypeScript primero.

## Decisión
- **Tauri** como shell: gestión de ventana, bandeja, atajos, almacenamiento seguro del SO, ciclo de vida
  del sidecar. Sin lógica de negocio en Rust.
- **Núcleo en TypeScript** como proceso sidecar.
- **IPC local** (stdio o named pipe) con token de sesión. **Sin puertos de red.**
- Fallback: si el spike falla en clic-through por píxel, migrar el shell a Electron manteniendo núcleo y UI.

## Alternativas
- Todo en Rust: menor memoria, pero se pierden los SDKs TS y se frena el ritmo de investigación.
- Electron desde el inicio: más seguro para overlays, ~100–200 MB más de RAM.

## Consecuencias
+ Núcleo reutilizable bajo cualquier shell. − Empaquetar un sidecar (Node/Bun) añade trabajo de distribución.
