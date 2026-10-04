# Guía de pruebas en Windows

Orden recomendado: **A** (instalar) → **B** (modo navegador con sidecar real: aquí se prueba casi todo) → **C** (voz con whisper.cpp real) → **D** (shell Tauri, solo overlay).
Anota los resultados en la tabla del final y en `docs/SPIKE_OVERLAY.md`. Todo lo que está marcado **[SIN PROBAR]** nunca se ha ejecutado en Windows.

## A. Instalar (10 min)

Requisitos: Git, **Node ≥ 22.13** (`node -v`), pnpm 10 (`corepack enable`).

```powershell
git clone https://github.com/juanortizpa/viernes.git
cd viernes
git checkout main && git pull
pnpm install
pnpm typecheck; pnpm test
```
**Esperado:** typecheck sin errores y `231 passed | 5 skipped`. Si falla un test en Windows, copia el nombre y el error (puede ser un test que asume rutas de Linux).

## B. Modo navegador con el sidecar real

### B1. Configuración
Usa tus 3 claves gratuitas. Copia la config multi-proveedor y **borra las secciones de los proveedores de los que no tengas clave** (si queda una sección sin su clave, el sidecar no arranca):

```powershell
copy jarvis.config.free-multi.example.json jarvis.config.json   # ya está en .gitignore
$env:GROQ_API_KEY = "<tu clave>"
$env:OPENROUTER_API_KEY = "<tu clave>"
$env:GEMINI_API_KEY = "<tu clave>"
$env:JARVIS_DATA_DIR = "$PWD\.jarvis"     # trazas, alias, caché y perfil de estilo persisten aquí
pnpm dev
```
Abre **http://localhost:5173** en Edge o Chrome. Arriba debe decir `LIVE · sidecar real · <modelos>` tras enviar la primera orden; "Sidecar: conectado" debajo de la caja.
Los errores del sidecar salen en esta misma terminal.

### B2. Pruebas funcionales (escribe cada frase en la caja)

| # | Escribe | Esperado |
|---|---|---|
| 1 | `hola` | Isla: "Respuesta rápida" casi instantánea; sin modelo (0 tokens) |
| 2 | `qué hora es` | Hora local legible, acción local, sin modelo |
| 3 | `qué día será mañana` | Fecha de mañana, local |
| 4 | `abre vscode`, `abre paint`, `abre teams`, `abre calculadora` | Se abre la app. Anota cuáles **fallan** **[SIN PROBAR]**: el escáner del Menú Inicio y las apps de la Store |
| 5 | `abre algoquenoexiste` | Va al modelo, no abre nada |
| 6 | `crea un proyecto de API con tests en python` | Aparece **"Recibido"** (acuse) de inmediato y luego "Usando <modelo>" |
| 7 | `cuál es la capital de Francia` (2 veces, con otras palabras la 2.ª: `dime la capital de Francia`) y una 3.ª `capital de francia por favor` | Las dos primeras van al modelo; la **3.ª sale en ~1 ms como "Respuesta guardada"** |
| 8 | `cuál es la capital de Italia` | Va al modelo (no debe confundirse con Francia) |
| 9 | `qué respuestas guardadas tienes` / `olvida la respuesta sobre francia` / `desactiva las respuestas guardadas` | Lista / borra / desactiva; `borra todas las respuestas guardadas` **pide confirmación** |
| 10 | 8+ mensajes con voseo (`decime…`, `contame…`, `vos podés…`, `tenés…`) y luego una pregunta | Las respuestas empiezan a usar voseo. `cómo es mi estilo` muestra lo aprendido; `olvida mi estilo` lo borra |
| 11 | Clic en la isla cuando está en reposo | Panel **AI Economy** (tareas, tokens, sin LLM, latencias). Con modelos gratis el ahorro en dólares debe decir que no hay precios configurados |
| 12 | Pregúntale al modelo `crea un archivo prueba.txt en esta carpeta con el texto hola` | Debe pedir **permiso**; el foco está en "Denegar"; `Esc` deniega |
| 13 | Una orden larga y pulsa **Cancelar** en la isla | La tarea se corta y la isla dice "Cancelado" |
| 14 | Cierra y reabre `pnpm dev` y repite el paso 7 con la misma pregunta | El caché y el alias aprendido siguen ahí (persisten en `.jarvis\`) |

Para los modelos reales: escribe una pregunta normal (`explica qué es un closure`) y mira en la isla qué modelo se usó y si escaló.

## C. Voz con whisper.cpp real (lo que más necesito validar)

1. Descarga **whisper.cpp para Windows** desde https://github.com/ggml-org/whisper.cpp/releases (zip `whisper-bin-x64.zip`; sin GPU, el normal). Descomprime en `C:\tools\whisper\`. Busca `whisper-cli.exe` (puede estar en una subcarpeta `Release`; en versiones antiguas se llama `main.exe`).
2. Descarga un **modelo multilingüe** (no uses los que terminan en `.en`, son solo inglés) a `C:\tools\whisper\`:
   ```powershell
   Invoke-WebRequest https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -OutFile C:\tools\whisper\ggml-base.bin
   ```
   (`ggml-tiny.bin` ≈ 75 MB, más rápido y peor; `ggml-base.bin` ≈ 142 MB; `ggml-small.bin` ≈ 466 MB, mejor y más lento.)
3. Añade a `jarvis.config.json` el bloque (usa `/` o `\\`, nunca una sola `\`):
   ```json
   "voice": { "binary": "C:/tools/whisper/whisper-cli.exe", "model": "C:/tools/whisper/ggml-base.bin", "language": "auto", "threads": 4 }
   ```
4. Reinicia `pnpm dev`, recarga la página. El botón 🎙 debe estar **habilitado** (si está gris, el sidecar no ve la config: revisa la terminal).
5. Pruebas (mantén pulsado 🎙 o **Ctrl+Espacio** con la página enfocada, habla, suelta):

| # | Haz | Esperado |
|---|---|---|
| V1 | Navegador pide permiso de micrófono | Aparece una vez; tras aceptar, funciona |
| V2 | Mantén pulsado, di "qué hora es", suelta | `Escuchando…` (aros del cuervo se mueven con tu voz) → `Transcribiendo…` → `Escuché: …` → la hora |
| V3 | Lo mismo en inglés: "what time is it" | Igual |
| V4 | "abre calculadora" | Abre la calculadora |
| V5 | Pulsa y suelta sin hablar (2 s de silencio) | Aviso "No se detectó voz"; **no** debe aparecer texto inventado |
| V6 | Un toque muy corto | "Muy corto: mantén pulsado mientras hablas" |
| V7 | Habla durante más de 20 s | Se corta solo a los 20 s y transcribe |
| V8 | Mientras dice `Transcribiendo…`, pulsa **Cancelar** | Se cancela |
| V9 | Mira el icono de micrófono de Windows | **Se enciende solo mientras pulsas** y se apaga al soltar |
| V10 | Mide el tiempo de soltar → `Escuché` con tiny, base y small (cambia `model`) | Anota los tres tiempos y si entendió bien el español |

**Si falla:** el mensaje corto sale en la UI y el detalle en la terminal (`transcription failed: …`). Casos típicos: ruta mal escrita, un modelo `.en`, o que `whisper-cli.exe` necesite una DLL que esté en otra carpeta.

## D. Shell Tauri (solo el overlay) **[SIN PROBAR]**

Instala Rust (MSVC) con https://rustup.rs y comprueba WebView2. Luego:

```powershell
cd apps\desktop
pnpm add -D @tauri-apps/cli
pnpm tauri icon ruta\a\cualquier-imagen-1024.png    # genera los iconos que exige el build
pnpm tauri dev
```
Recuerda: **Tauri aún no arranca el sidecar**, así que aquí solo existen los escenarios guionados (etiquetados DEMO); no hay voz ni economía real. Esta parte sirve para la tabla de `docs/SPIKE_OVERLAY.md` (transparencia, siempre encima, clic que atraviesa, pantalla completa, DPI, dos monitores). Si no compila, copia el error completo.

## Qué me tienes que devolver
1. Resultado de A (¿pasan los 231 tests?).
2. La tabla B2 con ✅/❌ y, en las ❌, lo que viste y el texto de la terminal.
3. La tabla C con los tiempos de V10 y si el reconocimiento en español fue bueno.
4. La tabla de `SPIKE_OVERLAY.md` (D) si llegas a ella.
5. Nunca pegues tus claves; si pegas la config, bórralas antes.
