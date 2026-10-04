import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Plugin } from "vite";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * DEV-ONLY bridge (ADR-0008): lets the browser demo talk to the real sidecar.
 * The sidecar itself opens no port and speaks NDJSON on stdio; this plugin spawns one sidecar
 * per WebSocket connection and pipes lines both ways. In Tauri, the shell does this piping.
 * The session token is only readable same-origin (no CORS headers), and the sidecar
 * re-checks it in its own handshake.
 */
export function jarvisBridge(): Plugin {
  return {
    name: "jarvis-bridge",
    apply: "serve",
    configureServer(server) {
      const token = randomBytes(24).toString("hex");
      const sidecarDir = resolve(server.config.root, "../sidecar");
      const tsxCli = resolve(sidecarDir, "node_modules/tsx/dist/cli.mjs");
      const main = resolve(sidecarDir, "src/main.ts");
      const configPath = resolve(server.config.root, "../../jarvis.config.json");

      server.middlewares.use("/__jarvis/token", (req, res) => {
        if (req.headers["sec-fetch-site"] === "cross-site") {
          res.statusCode = 403;
          return void res.end();
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ token }));
      });

      const wss = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });
      const attach = (ws: WebSocket): void => {
        const child = spawn(process.execPath, [tsxCli, main], {
          cwd: sidecarDir,
          env: { ...process.env, JARVIS_TOKEN: token, JARVIS_CONFIG: process.env.JARVIS_CONFIG ?? configPath },
          stdio: ["pipe", "pipe", "inherit"],
        });
        createInterface({ input: child.stdout }).on("line", (line) => ws.send(line));
        ws.on("message", (data) => child.stdin.write(data.toString().replace(/\n+$/, "") + "\n"));
        ws.on("close", () => child.stdin.end());
        child.on("error", () => ws.close(1011, "sidecar failed to start"));
        child.on("exit", () => ws.close(1000, "sidecar exited"));
      };

      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (req.url?.split("?")[0] !== "/__jarvis/ws") return;
        wss.handleUpgrade(req, socket, head, attach);
      });
    },
  };
}
