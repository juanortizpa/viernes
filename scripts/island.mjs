// Starts JARVIS as the floating island: the Tauri shell spawns the real sidecar itself (ADR-0021). No browser, no Vite server.
// Usage: node scripts/island.mjs [--rebuild] [--dev]
//   --rebuild  recompile the island even if it looks up to date
//   --dev      run `tauri dev` (hot reload, console logs) instead of the compiled island
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { islandNeedsBuild, newestMtime, parseEnvFile } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const args = new Set(process.argv.slice(2));
const desktop = join(root, "apps/desktop");
const exe = join(desktop, "src-tauri/target/release", win ? "jarvis-desktop.exe" : "jarvis-desktop");
const sidecar = join(root, "apps/sidecar/dist/sidecar.mjs");

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

if (!existsSync(join(root, "node_modules")) || !existsSync(join(root, "jarvis.config.json"))) fail("Falta la instalación. Ejecuta primero setup.bat.");

const envFile = join(root, "jarvis.env");
const env = {
  ...process.env,
  ...(existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {}),
  JARVIS_DATA_DIR: join(root, ".jarvis"),
  JARVIS_CONFIG: join(root, "jarvis.config.json"),
  // The shell starts the sidecar with exactly this Node (the one setup.bat validated) and this bundle.
  JARVIS_NODE: process.execPath,
  JARVIS_SIDECAR: sidecar,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};

/** Runs `cmd args` (fixed strings, never user input). On Windows through one command line: `shell: true` with an args array is deprecated (DEP0190). */
const sh = (cmd, argv, opts = {}) => (win ? spawnSync([cmd, ...argv].join(" "), { shell: true, env, ...opts }) : spawnSync(cmd, argv, { env, ...opts }));

const pnpm = [["pnpm"], ["corepack", "pnpm"]].find((c) => sh(c[0], [...c.slice(1), "--version"]).status === 0);
if (!pnpm) fail("No encuentro pnpm. Ejecuta: npm install -g pnpm");

// Pulling new code can add dependencies (the Tauri CLI came with the island itself): install them instead of failing later.
if (!existsSync(join(desktop, "node_modules/@tauri-apps/cli"))) {
  console.log("… faltan dependencias (las añadió una actualización); ejecutando pnpm install");
  if (sh(pnpm[0], [...pnpm.slice(1), "install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" }).status !== 0) fail("pnpm install falló. Copia el error de arriba.");
}
if (sh("cargo", ["--version"]).status !== 0) {
  fail("Falta Rust para compilar la isla. Instálalo desde https://rustup.rs (opción por defecto, MSVC), cierra y vuelve a abrir island.bat.\n  Mientras tanto, start.bat abre JARVIS en el navegador.");
}

// The sidecar bundle is cheap to rebuild (esbuild, ~1 s), so it is always fresh.
const { buildSidecar } = await import(pathToFileURL(join(root, "apps/sidecar/scripts/build.mjs")).href);
await buildSidecar(sidecar);
console.log("✔ sidecar empaquetado");

const run = (argv) => sh(pnpm[0], [...pnpm.slice(1), "--filter", "@jarvis/desktop", "exec", "tauri", ...argv], { cwd: root, stdio: "inherit" });

if (args.has("--dev")) {
  const r = run(["dev"]);
  process.exit(r.status ?? 1);
}

const sources = [
  join(desktop, "src"),
  join(desktop, "public"),
  join(desktop, "index.html"),
  join(desktop, "src-tauri/src"),
  join(desktop, "src-tauri/capabilities"),
  join(desktop, "src-tauri/icons"),
  join(desktop, "src-tauri/tauri.conf.json"),
  join(desktop, "src-tauri/Cargo.toml"),
  ...["protocol", "ipc", "voice"].map((p) => join(root, "packages", p, "src")),
];
const why = islandNeedsBuild({ exeMtime: existsSync(exe) ? statSync(exe).mtimeMs : 0, sourcesMtime: newestMtime(sources), force: args.has("--rebuild") });
if (why) {
  console.log(`… compilando la isla (${why}). La primera vez tarda varios minutos.`);
  if (run(["build", "--no-bundle"]).status !== 0 || !existsSync(exe)) fail("La compilación de la isla falló. Copia el error de arriba.");
}

// Detached: the island keeps running when this console closes. Sidecar logs go to .jarvis/sidecar.log.
spawn(exe, [], { cwd: root, env, detached: true, stdio: "ignore" }).unref();
console.log(`▶ Isla de JARVIS en marcha (arriba, en el centro de la pantalla). Logs del sidecar: ${join(".jarvis", "sidecar.log")}`);
