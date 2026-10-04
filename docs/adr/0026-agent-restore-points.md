# ADR-0026: Puntos de restauración del agente de programación («deshacé los cambios»)

**Estado:** aceptado · 2026-10-04 · barrida de funcionalidades

## Contexto
JARVIS delega la programación en Gemini CLI / Claude Code (ADR-0024), que editan archivos con `auto_edit`/`acceptEdits`. Si el
resultado no gusta, había que deshacerlo a mano. Claude Code tiene *rewind*; un asistente por voz lo necesita aún más: «deshacé lo
que hizo» tiene que funcionar sin abrir una terminal.

## Decisión
- **Antes y después de cada `code.agent`** (toda la cadena Gemini → Claude) se guarda una foto de los **archivos de trabajo del
  proyecto** (versionados + nuevos, respetando `.gitignore`) en el propio almacén de git, anclada en `refs/jarvis/agent/<id>-before`
  y `-after` (sobrevive a reinicios y a `git gc`).
- **No toca nada del usuario:** índice temporal propio (`GIT_INDEX_FILE`), ni ramas, ni HEAD, ni el área de staging.
- **Byte a byte:** los archivos se hashean con `hash-object --no-filters` y se restauran con `cat-file blob`, sin conversión de
  fin de línea ni filtros (LFS, `text=auto`). Hallazgo medido en esta máquina: con `core.autocrlf=true` la primera versión
  (basada en `git add`/`checkout-index`) devolvía los archivos LF como CRLF.
- **Solo la carpeta del proyecto, y solo si está versionada:** hallazgo real — en esta máquina `C:\Users\JUAN` es un repositorio
  git y la carpeta temporal está dentro; la primera versión «heredaba» ese repo y fotografiaba todo el perfil. Ahora un proyecto
  cuenta como versionado si es la raíz del repo o contiene archivos rastreados; uno dentro de un repo más grande solo cubre su carpeta.
- **Deshacer nunca pisa trabajo ajeno:** si algún archivo cambió después de que terminó el agente, se niega y lo nombra
  («deshacé los cambios igual» fuerza). Si el agente no llegó a registrar el «después» (se cortó el proceso), también se niega.
- **Órdenes locales, sin modelo:** «¿qué cambió el agente (en el proyecto X)?» → `code.changes` (lectura: archivos y `--stat`);
  «deshacé / revertí los cambios (del proyecto X)» → `code.undo` (`sensitive`: pide permiso; `modelCallable: false`: un modelo
  no puede deshacer por su cuenta). Sin nombrar proyecto se usa el último en que trabajó el agente.
- El resumen de `code.agent` dice «se puede deshacer» cuando corresponde.

## Verificado
Tests con repos git reales: editar/borrar/crear, staging e índice intactos, HEAD intacto, archivos ignorados fuera de alcance,
negativa ante ediciones posteriores y `force`, proyecto dentro de un repo mayor, carpeta dentro de un repo ajeno, CRLF/LF/mezcla/
binario con `autocrlf=true` y `text=auto`, y de punta a punta por el orquestador (orden → permiso → archivos restaurados).

## Límites
- Proyectos sin git no tienen punto de restauración (se dice). Los archivos ignorados (`node_modules`, `.env`) no se restauran.
- Un solo punto por proyecto: el último trabajo del agente. Directorios vacíos que creó el agente quedan.
- Archivos grandes no ignorados se copian al almacén de git en cada foto (como haría un commit).
