// Runs the speech-recognition calibration: node scripts/bench.mjs [--quick] [--model file.bin] [--apply] [--clear]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
if (!existsSync(join(root, "node_modules"))) {
  console.error("✖ Falta la instalación. Ejecuta primero setup.bat.");
  process.exit(1);
}
const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
const pnpm = [["pnpm"], ["corepack", "pnpm"]].find((c) => spawnSync(c[0], [...c.slice(1), "--version"], { shell: win, env }).status === 0);
if (!pnpm) {
  console.error("✖ No encuentro pnpm. Ejecuta: npm install -g pnpm");
  process.exit(1);
}
const r = spawnSync(pnpm[0], [...pnpm.slice(1), "--filter", "@jarvis/sidecar", "exec", "tsx", "src/bench.ts", ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit", shell: win });
process.exit(r.status ?? 1);
