// Speech-recognition regression check on a generated Spanish speech corpus (ADR-0020).
//   pnpm --filter @jarvis/sidecar exec tsx src/stt-eval.ts gen   # builds .jarvis/stt-corpus with Gemini TTS (needs GEMINI_API_KEY)
//   pnpm --filter @jarvis/sidecar exec tsx src/stt-eval.ts run   # runs the PRODUCTION speech pipeline on it, clean and degraded
// The corpus is synthetic speech (several TTS voices, fast/casual/hesitant phrasings): good for regressions, NOT a substitute for your voice.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppCatalog, IntentRouter } from "@jarvis/core";
import { encodeWav, prepareClip, resample } from "@jarvis/voice";
import { STT_CORPUS, degrade } from "./stt-corpus";
import { loadConfig } from "./config";
import { buildRuntime } from "./runtime";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = join(process.env.JARVIS_DATA_DIR ?? join(root, ".jarvis"), "stt-corpus");
const cfgPath = process.env.JARVIS_CONFIG ?? join(root, "jarvis.config.json");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function gen(): Promise<void> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is required to synthesise the corpus");
  mkdirSync(dir, { recursive: true });
  // Plain text only: these TTS models READ OUT style instructions ("say it quickly…") instead of following them.
  const models = ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "gemini-3.8-flash-lite-tts"];
  const voices = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
  for (let i = 0; i < STT_CORPUS.length; i++) {
    const file = join(dir, `${String(i + 1).padStart(2, "0")}.wav`);
    if (existsSync(file)) continue;
    for (let attempt = 0; attempt < 6; attempt++) {
      const model = models[(i + attempt) % models.length]!;
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: STT_CORPUS[i]!.text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voices[i % voices.length] } } } } }),
      });
      const j = (await r.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
      const data = j.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (data) {
        const pcm = Buffer.from(data, "base64"); // 24 kHz PCM16
        const s16 = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
        writeFileSync(file, encodeWav(resample({ samples: Float32Array.from(s16, (v) => v / 32768), sampleRate: 24_000 }, 16_000)));
        console.log(`${i + 1}/${STT_CORPUS.length} «${STT_CORPUS[i]!.text}»`);
        break;
      }
      await sleep(4000);
    }
    await sleep(2500);
  }
}

async function run(): Promise<void> {
  const config = loadConfig(cfgPath);
  const rt = buildRuntime({ ...config, scanApps: false }, { env: process.env, launcher: async () => {} });
  if (!rt.transcriber) throw new Error("no speech engine configured (keys or local whisper)");
  console.log(`Motores: ${rt.voiceEngines.join(" → ")}`);
  const router = new IntentRouter({ apps: AppCatalog.fromRecord(config.apps) });
  const action = (t: string): string => {
    const r = router.resolve(t);
    return r.route === "llm" ? "llm" : r.tool === "apps.open" ? `apps.open:${String(r.args.app)}` : r.tool === "time.date" ? `time.date:${String(r.args.offsetDays)}` : r.tool;
  };
  for (const cond of ["limpio", "degradado"] as const) {
    let ok = 0;
    const lat: number[] = [];
    for (let i = 0; i < STT_CORPUS.length; i++) {
      const file = join(dir, `${String(i + 1).padStart(2, "0")}.wav`);
      if (!existsSync(file)) throw new Error(`missing ${file}: run "gen" first`);
      const raw = new Uint8Array(readFileSync(file));
      const t0 = Date.now();
      const t = await rt.transcriber.transcribe(prepareClip(cond === "limpio" ? raw : degrade(raw)).wav);
      lat.push(Date.now() - t0);
      const got = action(t.text);
      if (got === STT_CORPUS[i]!.expect) ok++;
      else console.log(`   ✗ «${STT_CORPUS[i]!.text}» → «${t.text}» (${t.engine}) → ${got}`);
      await sleep(4300); // free-tier pacing
    }
    lat.sort((a, b) => a - b);
    console.log(`${cond}: acción correcta ${ok}/${STT_CORPUS.length} · latencia mediana ${lat[Math.floor(lat.length / 2)]} ms · máx ${lat.at(-1)} ms`);
  }
}

const cmd = process.argv[2];
await (cmd === "gen" ? gen() : cmd === "run" ? run() : Promise.reject(new Error("usage: stt-eval.ts gen|run")));
