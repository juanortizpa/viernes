// Starts JARVIS in browser mode (real sidecar) and opens the page. Usage: node scripts/start.mjs [--no-open]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const PORT = 5173;
const url = `http://localhost:${PORT}/`;

if (!existsSync(join(root, "node_modules")) || !existsSync(join(root, "jarvis.config.json"))) {
  console.error("✖ Falta la instalación. Ejecuta primero setup.bat.");
  process.exit(1);
}
const envFile = join(root, "jarvis.env");
const env = { ...process.env, ...(existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {}), JARVIS_DATA_DIR: join(root, ".jarvis"), JARVIS_CONFIG: join(root, "jarvis.config.json"), COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
const pnpm = [["pnpm"], ["corepack", "pnpm"]].find((c) => spawnSync(c[0], [...c.slice(1), "--version"], { shell: win, env }).status === 0);
if (!pnpm) {
  console.error("✖ No encuentro pnpm. Ejecuta: npm install -g pnpm");
  process.exit(1);
}

// 127.0.0.1 only: the dev bridge can run commands on this PC, so it must not be reachable from the network.
const child = spawn(pnpm[0], [...pnpm.slice(1), "--filter", "@jarvis/desktop", "exec", "vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: root, env, stdio: "inherit", shell: win });
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill());

if (!process.argv.includes("--no-open")) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* not up yet */
    }
  }
  console.log(`\n▶ JARVIS en ${url}  (Ctrl+C para cerrar)`);
  if (win) spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
