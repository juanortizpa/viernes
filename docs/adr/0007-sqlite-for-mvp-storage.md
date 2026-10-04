# ADR-0007: SQLite + sqlite-vec en el MVP (Postgres diferido)

**Estado:** propuesto · 2026-10-03

## Contexto
La visión original usa PostgreSQL + pgvector. En una app de escritorio de un solo usuario, Postgres
implica instalar, ejecutar y actualizar un servidor, y empaquetarlo para el usuario final.

## Decisión
Memoria, telemetría y estado en **SQLite** con **sqlite-vec** para búsqueda semántica, detrás de una
interfaz de almacenamiento (`MemoryStore`, repositorio de trazas). PostgreSQL + pgvector se reevalúa en V2
si se añade sincronización multi-dispositivo o volumen que lo justifique.

## Consecuencias
+ Cero servicios que instalar, copia de seguridad = un archivo. − Si se migra, hay que escribir un
adaptador y un script de migración (acotado por la interfaz).
