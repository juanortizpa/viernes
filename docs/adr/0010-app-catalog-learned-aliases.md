# ADR-0010: Catálogo de apps y alias aprendidos

**Estado:** aceptado · 2026-10-04

## Contexto
La tabla fija de alias en la config obliga a editar a mano cada app (Paint, navegador…). Se quiere que el sistema
conozca las apps del usuario y aprenda sus formas de nombrarlas, sin abrir un camino para que el LLM o el texto
externo introduzcan comandos nuevos (ADR-0005).

## Decisión
- **`AppCatalog`** (core) une tres fuentes con prioridad `config > learned > scan`; una fuente inferior nunca pisa a una superior.
- **Escáner** (`apps/sidecar/src/app-scanner.ts`): lista los `.lnk` del Menú Inicio (máquina y usuario) en Windows. El
  comando es la ruta del acceso directo; no se interpreta ninguna línea de comandos. Se omiten desinstaladores y nombres con
  caracteres que `cmd.exe` interpretaría. En otros SO devuelve vacío. Se desactiva con `scanApps: false`.
- **Coincidencia aproximada determinista** (sin LLM): el texto es subcadena de exactamente una app ("chrome" → "Google Chrome")
  o una errata de una letra (≥4 caracteres). Si hay ambigüedad (`note` → OneNote / Notepad++) no se adivina y cae al LLM.
- **Aprender = confirmar.** Con una coincidencia aproximada el intent abre la app y encadena (`then`) la herramienta
  `aliases.learn`, de riesgo `sensitive`: el policy engine exige confirmación del usuario. Si la rechaza no se guarda nada.
- **Un alias nunca introduce un comando nuevo:** `learn` solo acepta comandos ya presentes en el catálogo. Además el
  lanzador de `apps.open` rechaza cualquier comando fuera del catálogo, lo proponga el intent local o el modelo.
- **Persistencia:** `SqliteAliasStore` (`aliases.db` en `JARVIS_DATA_DIR`); al arrancar se restauran solo los alias cuyo comando
  sigue existiendo. Visibles y borrables: "qué alias has aprendido" (`aliases.list`), "olvida el alias X" (`aliases.forget`, solo
  los aprendidos).

## Consecuencias
+ "abre Paint" funciona sin config; el usuario enseña apodos con una confirmación. + Superficie de lanzamiento acotada al catálogo.
− Si el usuario rechaza, se vuelve a preguntar la próxima vez (sin memoria negativa; V2). − Solo apps de escritorio con acceso directo
(no UWP/Store ni PATH). − Las "skills" (macros de varias herramientas) y el código generado siguen fuera de alcance (V2 / investigación).
