# ADR-0001: Monorepo y límites de paquetes

**Estado:** aceptado · 2026-10-03

## Contexto
JARVIS tiene piezas con ciclos de vida distintos (UI, orquestador, router, herramientas, investigación)
que deben permanecer modulares y testeables.

## Decisión
Monorepo pnpm con `apps/*` y `packages/*`. `packages/protocol` es la única fuente de verdad de los
contratos (zod). Reglas de dependencia:

- `protocol` no depende de nada del repo.
- `router` depende de `protocol` (`ModelCapabilities`), **nunca** de `providers/*`.
- `providers/*` implementan una interfaz definida en `protocol`; el orquestador los recibe por inyección.
- La UI solo consume eventos de `protocol`; no importa lógica del orquestador.
- `research/` puede importar de cualquier paquete; ningún paquete importa de `research/`.

## Consecuencias
+ Añadir un proveedor no toca el orquestador. + Contratos validados en runtime en los bordes.
− Más ceremonia inicial que un único paquete; se acepta por la modularidad exigida.
