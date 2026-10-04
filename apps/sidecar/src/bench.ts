// Speech-recognition calibration on YOUR recordings: pnpm --filter @jarvis/sidecar exec tsx src/bench.ts [--quick] [--model <file.bin>] [--apply] [--clear]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppCatalog, IntentRouter } from "@jarvis/core";
import { GeminiTranscriber, GroqTranscriber, RaceTranscriber, WhisperCppTranscriber, type Transcriber } from "@jarvis/voice";
import { loadConfig } from "./config";
import { renderTable, searchBest, type Clip } from "./bench-lib";
import { defaultVoicePrompt } from "./runtime";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(`--${n}`);
const opt = (n: string): string | undefined => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dataDir = process.env.JARVIS_DATA_DIR ?? join(root, ".jarvis");
const benchDir = join(dataDir, "bench");
const cfgPath = process.env.JARVIS_CONFIG ?? join(root, "jarvis.config.json");

if (flag("clear")) {
  rmSync(benchDir, { recursive: true, force: true });
  console.log(`Grabaciones de prueba borradas (${benchDir}).`);
  process.exit(0);
}

const config = loadConfig(cfgPath);
const voice = config.voice ?? { engine: "auto" as const, cloudModel: "whisper-large-v3-turbo", understandModel: "gemini-3.5-flash-lite", language: "es", wakeWords: ["jarvis"], beamSize: 5, timeoutMs: 60_000, binary: undefined, model: undefined, wakeModel: undefined, threads: undefined, prompt: undefined };
const groqKey = process.env.GROQ_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const localOk = Boolean(voice.binary && existsSync(voice.binary) && voice.engine !== "groq" && voice.engine !== "gemini");
const cloudOk = Boolean((groqKey || geminiKey) && voice.engine !== "local");
if (!localOk && !cloudOk) {
  console.error("✖ No hay motor de voz: falta whisper local (setup.bat) y no hay GROQ_API_KEY en jarvis.env.");
  process.exit(1);
}

// ---- clips recorded in the UI -----------------------------------------------------------------------------------------------------
const clips: Clip[] = [];
if (existsSync(benchDir)) {
  for (const f of readdirSync(benchDir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const meta = JSON.parse(readFileSync(join(benchDir, f), "utf8")) as { phrase: string; mode: string };
      const wavPath = join(benchDir, f.replace(/\.json$/, ".wav"));
      if (existsSync(wavPath)) clips.push({ id: basename(f, ".json"), reference: meta.phrase, mode: meta.mode, wav: new Uint8Array(readFileSync(wavPath)) });
    } catch {
      /* ignore a half-written clip */
    }
  }
}
const used = flag("quick") ? clips.slice(0, 8) : clips;
if (used.length < 4) {
  console.error(`✖ Hay ${clips.length} grabaciones y se necesitan al menos 4.\n  Abre la app (start.bat), baja a «Prueba de transcripción», graba las frases (idealmente las dos pasadas) y vuelve a ejecutar esto.`);
  process.exit(1);
}

// ---- models to compare ------------------------------------------------------------------------------------------------------------
const toolsDir = join(root, "tools", "whisper");
const candidates = new Set<string>();
if (localOk) {
  for (const m of [voice.model, voice.wakeModel]) if (m) candidates.add(m);
  if (existsSync(toolsDir)) for (const f of readdirSync(toolsDir)) if (/^ggml-.*\.bin$/.test(f)) candidates.add(join(toolsDir, f));
}
const only = opt("model");
const localModels = [...candidates].filter((m) => existsSync(m) && statSync(m).size > 30e6).sort((a, b) => statSync(a).size - statSync(b).size);
// Cloud engines (Groq's hosted whisper large-v3) are compared too when there is a key: the audio of these test clips goes to Groq.
const cloudModels = cloudOk
  ? [
      ...(groqKey ? ["groq:whisper-large-v3-turbo", "groq:whisper-large-v3"] : []),
      ...(geminiKey ? [`gemini:${voice.understandModel}`] : []),
      ...(groqKey && geminiKey ? ["race"] : []),
    ]
  : [];
const models = [...cloudModels, ...localModels].filter((m) => !only || basename(m) === only || m === only);
const isCloud = (m: string): boolean => m === "race" || m.startsWith("groq:") || m.startsWith("gemini:");
const label = (m: string): string => (m === "race" ? "Groq turbo + Gemini en paralelo (nube)" : isCloud(m) ? `${m} (nube)` : basename(m));
const size = (m: string): string => (isCloud(m) ? "nube" : `${Math.round(statSync(m).size / 1e6)} MB`);
const quickRouter = new IntentRouter({ apps: AppCatalog.fromRecord(config.apps) });
const paced = (t: Transcriber, ms: number): Transcriber => ({ transcribe: async (w, o) => (await new Promise((r) => setTimeout(r, ms)), t.transcribe(w, o)) });
if (models.length === 0) {
  console.error("✖ No encuentro modelos de whisper para comparar.");
  process.exit(1);
}

const modes = [...new Set(used.map((c) => c.mode))];
console.log(`Comparando ${models.length} modelo(s) sobre ${used.length} grabaciones (${modes.join(", ")}).`);
console.log(`Modelos: ${models.map((m) => `${label(m)} [${size(m)}]`).join(", ")}`);
console.log("Tarda unos minutos; cada línea sale al terminar su configuración.\n");

const prompt = defaultVoicePrompt(Object.keys(config.apps), voice.language);
const { rows, best } = await searchBest(
  {
    models,
    modelLabel: label,
    make: ({ model, prompt: usePrompt, beam }): Transcriber => {
      // Free tiers allow ~15-20 requests/minute: pace the calls instead of hitting the limit.
      const groq = (m: string) => new GroqTranscriber({ apiKey: groqKey!, model: m, language: voice.language, prompt: usePrompt ? prompt : undefined });
      const gemini = () => new GeminiTranscriber({ apiKey: geminiKey!, model: voice.understandModel, vocabulary: Object.keys(config.apps).slice(0, 20) });
      if (model.startsWith("groq:")) return paced(groq(model.slice(5)), 3100);
      if (model.startsWith("gemini:")) return paced(gemini(), 4300);
      if (model === "race") return paced(new RaceTranscriber({ fast: groq("whisper-large-v3-turbo"), accurate: gemini(), acceptFast: (t) => { const r = quickRouter.resolve(t); return r.route === "local" && r.confidence === 1; } }), 4300);
      return new WhisperCppTranscriber({ binary: voice.binary!, model, language: voice.language, threads: voice.threads, timeoutMs: voice.timeoutMs, beamSize: beam, prompt: usePrompt ? prompt : undefined });
    },
    baseline: { prepared: true, prompt: true, beam: voice.beamSize },
  },
  used,
  (r) => console.log(`  ${(r.wer * 100).toFixed(1).padStart(5)}% error · ${String(r.medianMs).padStart(5)} ms  ${r.label}`),
);

const table = renderTable(rows);
const top = [...rows].sort((a, b) => a.wer - b.wer || a.medianMs - b.medianMs)[0]!;
const byMode = Object.entries(top.byMode);
const report = [
  "# Prueba de transcripción", "", `Grabaciones: ${used.length} (${modes.join(", ")}). Error de palabras = palabras mal / palabras de referencia (menor es mejor).`, "", table, "",
  "## Mejor configuración", "", `- Modelo: \`${label(best.model)}\``, `- Beam: ${best.beam}`, `- Prompt de vocabulario: ${best.prompt ? "sí (el de por defecto)" : "no (pon `\"prompt\": \"\"` en voice)"}`,
  `- Procesamiento previo: ${best.prepared ? "nivelado + margen (el de producción)" : "SIN procesar fue mejor: avísame, hay que revisar el procesamiento"}`,
  ...(byMode.length > 1 ? ["", "Por modo de captura con la mejor configuración: " + byMode.map(([m, e]) => `${m} ${(e * 100).toFixed(1)}%`).join(" · ")] : []),
].join("\n");
mkdirSync(benchDir, { recursive: true });
writeFileSync(join(benchDir, "report.md"), report + "\n");
console.log("\n" + report);

const dspOn = top.byMode["dsp-on"];
const dspOff = top.byMode["dsp-off"];
if (dspOn !== undefined && dspOff !== undefined && Math.abs(dspOn - dspOff) >= 0.05) {
  console.log(`\n➜ Procesamiento del navegador: ${dspOff < dspOn ? "SIN procesar (dsp-off)" : "CON procesar (dsp-on)"} transcribe mejor (${(Math.min(dspOn, dspOff) * 100).toFixed(1)}% vs ${(Math.max(dspOn, dspOff) * 100).toFixed(1)}%). Cámbialo en la app: «Audio del navegador».`);
}

const applyText = best.model === "race"
  ? `voice.engine = "auto" (Groq + Gemini en paralelo; necesita las dos claves)`
  : best.model.startsWith("gemini:")
    ? `voice.engine = "gemini" · voice.understandModel = "${best.model.slice(7)}"`
    : best.model.startsWith("groq:")
  ? `voice.engine = "groq" · voice.cloudModel = "${best.model.slice(5)}" · voice.prompt ${best.prompt ? "(sin cambios)" : '= ""'}`
  : `voice.engine = "local" · voice.model = ${best.model.replaceAll("\\", "/")} · voice.beamSize = ${best.beam} · voice.prompt ${best.prompt ? "(sin cambios)" : '= ""'}`;
console.log(`\nPara aplicar en jarvis.config.json:  ${applyText}`);
if (flag("apply")) {
  copyFileSync(cfgPath, `${cfgPath}.bak`);
  const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as { voice?: Record<string, unknown> };
  raw.voice ??= {};
  if (best.model === "race") raw.voice.engine = "auto";
  else if (best.model.startsWith("gemini:")) (raw.voice.engine = "gemini"), (raw.voice.understandModel = best.model.slice(7));
  else if (best.model.startsWith("groq:")) {
    raw.voice.engine = "groq";
    raw.voice.cloudModel = best.model.slice(5);
  } else {
    raw.voice.engine = "local";
    raw.voice.model = best.model.replaceAll("\\", "/");
    raw.voice.beamSize = best.beam;
  }
  if (!best.prompt) raw.voice.prompt = "";
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");
  console.log(`✔ Aplicado (copia anterior en ${basename(cfgPath)}.bak). Reinicia start.bat.`);
} else console.log("  (o ejecuta de nuevo con --apply para que lo escriba por ti)");
