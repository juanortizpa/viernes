import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

      // DEV-ONLY: saves calibration recordings (speech-recognition benchmark) next to the project data. Same-origin only, size-capped,
      // filenames derived from a slug (never from client paths).
      server.middlewares.use("/__jarvis/bench/save", (req, res) => {
        const fail = (code: number, msg: string): void => {
          res.statusCode = code;
          res.end(msg);
        };
        if (req.method !== "POST") return fail(405, "POST only");
        if (req.headers["sec-fetch-site"] === "cross-site") return fail(403, "cross-site");
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 3_000_000) (fail(413, "too large"), req.destroy());
          else chunks.push(c);
        });
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { phrase?: unknown; mode?: unknown; wav?: unknown };
            if (typeof body.phrase !== "string" || body.phrase.length < 1 || body.phrase.length > 200) return fail(400, "bad phrase");
            if (body.mode !== "dsp-on" && body.mode !== "dsp-off") return fail(400, "bad mode");
            if (typeof body.wav !== "string") return fail(400, "bad wav");
            const wav = Buffer.from(body.wav, "base64");
            if (wav.length < 1000 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return fail(400, "not a wav");
            const dir = resolve(process.env.JARVIS_DATA_DIR ?? resolve(server.config.root, "../../.jarvis"), "bench");
            mkdirSync(dir, { recursive: true });
            const slug = body.phrase.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "clip";
            const id = `${Date.now()}-${body.mode}-${slug}`;
            writeFileSync(resolve(dir, `${id}.wav`), wav);
            writeFileSync(resolve(dir, `${id}.json`), JSON.stringify({ phrase: body.phrase, mode: body.mode, savedAt: Date.now() }));
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, id }));
          } catch {
            fail(400, "bad request");
          }
        });
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
