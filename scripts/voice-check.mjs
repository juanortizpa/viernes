// Diagnoses the speech-to-text setup: node scripts/voice-check.mjs
// Runs exactly what the sidecar runs, and prints the real exit code / stdout / stderr.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { explainExitCode, isDeprecatedWhisperStub } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = join(root, "jarvis.config.json");
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => (console.log(`  ✖ ${m}`), (failed = true));
let failed = false;

console.log("Diagnóstico de voz");
if (!existsSync(cfgPath)) (bad("no existe jarvis.config.json: ejecuta setup.bat"), process.exit(1));
const voice = JSON.parse(readFileSync(cfgPath, "utf8")).voice;
if (!voice) (bad("jarvis.config.json no tiene la sección \"voice\": setup.bat no instaló la voz"), process.exit(1));
console.log(`  binario: ${voice.binary}\n  modelo : ${voice.model}\n  idioma : ${voice.language}`);

if (!existsSync(voice.binary)) bad("el binario no existe en esa ruta");
else ok("el binario existe");
if (isDeprecatedWhisperStub(voice.binary)) bad("es main.exe: un binario OBSOLETO que no transcribe. Vuelve a ejecutar setup.bat (ahora elige whisper-cli.exe)");
if (!existsSync(voice.model)) bad("el modelo no existe en esa ruta");
else {
  const mb = Math.round(statSync(voice.model).size / 1e6);
  mb < 70 ? bad(`el modelo pesa solo ${mb} MB: descarga incompleta, bórralo y vuelve a ejecutar setup.bat`) : ok(`modelo de ${mb} MB`);
  if (/\.en\./.test(voice.model)) bad("es un modelo solo-inglés (.en): no entenderá español");
}
if (failed) process.exit(1);

// 1) can the program start at all? (missing DLLs fail here)
const help = spawnSync(voice.binary, ["--help"], { encoding: "utf8", windowsHide: true });
if (help.error) (bad(`no se pudo ejecutar: ${help.error.message}`), process.exit(1));
help.status === 0 || /usage|whisper/i.test(`${help.stdout}${help.stderr}`) ? ok("el programa arranca") : bad(`el programa no arranca: código ${explainExitCode(help.status)}\n${(help.stderr || help.stdout).slice(-400)}`);
if (failed) process.exit(1);

// 2) transcribe a 2 s tone (no speech: the expected result is an empty text, but the process must exit 0)
const rate = 16000;
const n = rate * 2;
const wav = Buffer.alloc(44 + n * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2);
const dir = mkdtempSync(join(tmpdir(), "jarvis-vc-"));
const file = join(dir, "tone.wav");
writeFileSync(file, wav);
const args = ["-m", voice.model, "-f", file, "-l", voice.language ?? "auto", "-nt", "-np"];
console.log(`\n  Ejecutando: ${voice.binary} ${args.join(" ")}`);
const t0 = Date.now();
const r = spawnSync(voice.binary, args, { encoding: "utf8", windowsHide: true, timeout: 120000 });
rmSync(dir, { recursive: true, force: true });
console.log(`  duración: ${((Date.now() - t0) / 1000).toFixed(1)} s · código de salida: ${explainExitCode(r.status)}`);
if (r.error) bad(`error al ejecutar: ${r.error.message}`);
else if (r.status !== 0) bad(`falló.\n--- stderr (final) ---\n${(r.stderr || "").slice(-1200)}\n--- stdout ---\n${(r.stdout || "").slice(-400)}`);
else ok(`transcribió sin errores (texto devuelto: ${JSON.stringify((r.stdout || "").trim().slice(0, 80))})`);
console.log(failed ? "\nResultado: HAY UN PROBLEMA. Copia todo lo de arriba." : "\nResultado: whisper funciona. Si la app aún falla, copia la línea \"transcription failed\" de la ventana de start.bat.");
process.exit(failed ? 1 : 0);
