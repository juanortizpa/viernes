import { createInterface } from "node:readline";
import { encodeLine, type ServerMessage } from "@jarvis/ipc";
import { EventBus } from "@jarvis/core";
import { loadConfig } from "./config";
import { launchApp } from "./launcher";
import { buildRuntime } from "./runtime";
import { SidecarServer } from "./server";

/**
 * Sidecar entry (ADR-0002). Protocol on stdout/stdin, one JSON message per line; logs go to
 * stderr only so stdout stays a clean channel. No network port is opened.
 * The host (Tauri shell or the dev bridge) provides JARVIS_TOKEN in the environment.
 */
const token = process.env.JARVIS_TOKEN;
if (!token) {
  console.error("JARVIS_TOKEN is required");
  process.exit(2);
}

const runtime = buildRuntime(loadConfig(process.env.JARVIS_CONFIG), { env: process.env, launcher: launchApp });
const send = (m: ServerMessage): void => void process.stdout.write(encodeLine(m));
const bus = new EventBus();

const server = new SidecarServer({
  token,
  send,
  bus,
  createOrchestrator: runtime.createOrchestrator,
  info: { models: runtime.models, offline: runtime.offline },
  onFatal: () => setTimeout(() => process.exit(3), 50),
  log: (l) => console.error(`[sidecar] ${l}`),
});

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => server.handleLine(line));
rl.on("close", () => {
  server.close();
  process.exit(0);
});
console.error(`[sidecar] ready (offline=${runtime.offline}, models=${runtime.models.join(",")})`);
