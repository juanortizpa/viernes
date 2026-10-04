// One-shot setup: node scripts/setup.mjs [--no-voice] [--model tiny|base|small] [--lang es|en|auto] [--test]
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { PINNED_WHISPER_ZIP, isDeprecatedWhisperStub, PROVIDER_KEYS, WHISPER_MODELS, buildConfig, describeAssets, findFile, nodeOk, parseEnvFile, pickFromReleases, serializeEnv } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const say = (m = "") => console.log(m);
const step = (m) => console.log(`\n▶ ${m}`);
const win = process.platform === "win32";

if (!nodeOk(process.version)) {
  console.error(`✖ Node ${process.version} es muy antiguo: se necesita 22.13 o superior (https://nodejs.org).`);
  process.exit(1);
}

/** pnpm directly, or through corepack when `corepack enable` was not run (it needs admin on some installs). */
function pnpmCommand() {
  for (const cmd of [["pnpm"], ["corepack", "pnpm"]]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { shell: win, encoding: "utf8", env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
    if (r.status === 0) return cmd;
  }
  return undefined;
}
const run = (cmd, cmdArgs, opts = {}) => spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: win, cwd: root, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }, ...opts });

async function download(url, dest, minBytes) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "jarvis-setup" } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let got = 0;
  let last = 0;
  const part = `${dest}.part`;
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    got += c.length;
    if (total && got - last > total / 20) (process.stdout.write(`  ${Math.round((got / total) * 100)}%\r`), (last = got));
  });
  await pipeline(body, createWriteStream(part));
  if (minBytes && statSync(part).size < minBytes) throw new Error(`descarga incompleta (${statSync(part).size} bytes)`);
  renameSync(part, dest);
}

// 1. Dependencies
step("Instalando dependencias (pnpm install)");
const pnpm = pnpmCommand();
if (!pnpm) {
  console.error("✖ No encuentro pnpm. Abre una terminal y ejecuta:  npm install -g pnpm   (y vuelve a lanzar setup.bat)");
  process.exit(1);
}
if (run(pnpm[0], [...pnpm.slice(1), "install", "--frozen-lockfile"]).status !== 0) process.exit(1);

// 2. API keys (kept in jarvis.env, which is git-ignored; never printed back)
step("Claves de API (opcionales: Enter para saltar una)");
const envPath = join(root, "jarvis.env");
const saved = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : {};
const keys = { ...saved };
const rl = createInterface({ input: process.stdin, output: process.stdout });
for (const [section, name] of Object.entries(PROVIDER_KEYS)) {
  const have = process.env[name] || saved[name];
  if (have) {
    keys[name] = have;
    say(`  ${name}: ya configurada`);
    continue;
  }
  if (!process.stdin.isTTY) continue;
  const v = (await rl.question(`  ${name} (${section}) [Enter = no usar]: `)).trim();
  if (v) keys[name] = v;
}
rl.close();
writeFileSync(envPath, serializeEnv(keys));
if (Object.keys(PROVIDER_KEYS).every((s) => !keys[PROVIDER_KEYS[s]])) say("  ⚠ Sin ninguna clave: JARVIS arrancará en modo offline (el modelo responde con un eco etiquetado).");

// 3. Voice: whisper.cpp binary + model (Windows only; the binary is a .exe)
let voice;
if (!flag("no-voice")) {
  step("Voz: whisper.cpp + modelo");
  const dir = join(root, "tools", "whisper");
  const model = WHISPER_MODELS[opt("model", "base")] ?? WHISPER_MODELS.base;
  mkdirSync(dir, { recursive: true });
  try {
    let bin = findFile(dir, ["whisper-cli.exe", "main.exe"]); // order = preference
    if (!win) say("  ⚠ No es Windows: salto la descarga del binario (whisper-cli.exe). Usa --no-voice o configura voice a mano.");
    else {
      // Options: --whisper-bin <whisper-cli.exe you already have>, --whisper-zip <local zip or https URL>
      if (opt("whisper-bin") && existsSync(opt("whisper-bin"))) bin = opt("whisper-bin");
      if (!bin) {
        const zip = join(dir, "whisper.zip");
        let source = opt("whisper-zip");
        if (!source) {
          say("  Buscando una versión de whisper.cpp con binarios para Windows…");
          let releases;
          try {
            const res = await fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20", { headers: { "user-agent": "jarvis-setup" } });
            releases = res.ok ? await res.json() : undefined;
          } catch {
            /* offline or rate limited: use the pinned fallback below */
          }
          const found = pickFromReleases(releases);
          if (found) {
            say(`  Usando ${found.asset.name} de ${found.tag}`);
            source = found.asset.browser_download_url;
          } else {
            say(`  La API no listó un zip de Windows utilizable. Archivos que vi:\n    ${describeAssets(releases) || "(nada: ¿sin internet o límite de GitHub?)"}`);
            say("  Pruebo la versión fija v1.7.5…");
            source = PINNED_WHISPER_ZIP;
          }
        }
        if (/^https?:/i.test(source)) await download(source, zip);
        else if (existsSync(source)) writeFileSync(zip, readFileSync(source));
        else throw new Error(`no existe ${source}`);
        const t = spawnSync("tar", ["-xf", zip, "-C", dir], { encoding: "utf8" }); // bsdtar ships with Windows 10+
        if (t.status !== 0) throw new Error(`no pude descomprimir el zip: ${t.stderr}`);
        rmSync(zip, { force: true });
        bin = findFile(dir, ["whisper-cli.exe", "main.exe"]);
        if (!bin) throw new Error("el zip no contiene whisper-cli.exe ni main.exe");
      } else say("  Binario ya presente.");
      if (isDeprecatedWhisperStub(bin)) throw new Error(`${bin} es un binario obsoleto que no transcribe; hace falta whisper-cli.exe`);
      const modelPath = join(dir, model.file);
      if (!existsSync(modelPath) || statSync(modelPath).size < model.minBytes) {
        say(`  Descargando modelo ${model.file}…`);
        await download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.file}`, modelPath, model.minBytes);
      } else say("  Modelo ya presente.");
      voice = { binary: bin, model: modelPath, language: opt("lang", "es") };
    }
  } catch (e) {
    say(`  ⚠ Voz no instalada: ${e instanceof Error ? e.message : e}. El resto funciona; puedes reintentar con setup.bat.`);
  }
}

// 4. Config
step("Escribiendo jarvis.config.json");
const base = JSON.parse(readFileSync(join(root, "jarvis.config.free-multi.example.json"), "utf8"));
const cfg = buildConfig({ base, env: keys, voice });
const cfgPath = join(root, "jarvis.config.json");
if (existsSync(cfgPath) && readFileSync(cfgPath, "utf8") !== JSON.stringify(cfg, null, 2) + "\n") {
  renameSync(cfgPath, `${cfgPath}.bak`);
  say("  (tu config anterior quedó en jarvis.config.json.bak)");
}
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
const used = Object.keys(PROVIDER_KEYS).filter((s) => cfg[s]);
say(`  Proveedores: ${used.join(", ") || "ninguno (offline)"} · Voz: ${cfg.voice ? "sí" : "no"}`);

if (flag("test")) {
  step("Pruebas");
  run(pnpm[0], [...pnpm.slice(1), "test"]);
}

say("\n✔ Listo. Ahora haz doble clic en start.bat (o ejecuta: node scripts/start.mjs).");
