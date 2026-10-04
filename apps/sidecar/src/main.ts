import { join } from "node:path";
import { createInterface } from "node:readline";
import { encodeLine, type ServerMessage } from "@jarvis/ipc";
import { EventBus, MemoryTraceStore } from "@jarvis/core";
import { SqliteAliasStore, SqliteInstantStore, SqliteMemoryStore, SqliteTraceStore } from "@jarvis/storage";
import { planSpawn } from "@jarvis/agents";
import { connectMcpServers, type McpConnections } from "@jarvis/mcp";
import { defaultStartMenuRoots, scanInstalledApps } from "./app-scanner";
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

const config = loadConfig(process.env.JARVIS_CONFIG);
const dataDir = process.env.JARVIS_DATA_DIR;
const traceDb = dataDir ? join(dataDir, "traces.db") : config.traceDb;
const traces = traceDb ? new SqliteTraceStore(traceDb) : new MemoryTraceStore();
const aliases = dataDir ? new SqliteAliasStore(join(dataDir, "aliases.db")) : undefined;
const instantStore = dataDir ? new SqliteInstantStore(join(dataDir, "instant.db")) : undefined;
const memoryStore = dataDir ? new SqliteMemoryStore(join(dataDir, "memory.db")) : undefined;
const scanned = config.scanApps ? await scanInstalledApps(defaultStartMenuRoots(process.env)) : [];
const runtime = buildRuntime(config, { env: process.env, launcher: launchApp, traces, aliases, instantStore, memoryStore, scanned });
for (const w of runtime.warnings) console.error(`[sidecar] aviso: ${w}`);
const send = (m: ServerMessage): void => void process.stdout.write(encodeLine(m));
const bus = new EventBus();

const server = new SidecarServer({
  token,
  send,
  bus,
  createOrchestrator: runtime.createOrchestrator,
  info: { models: runtime.models, offline: runtime.offline, voiceEngines: runtime.voiceEngines },
  transcriber: runtime.transcriber,
  wakeTranscriber: runtime.wakeTranscriber,
  wakeWords: runtime.wakeWords,
  streaming: runtime.streaming,
  economy: runtime.economy,
  memory: runtime.memory,
  onFatal: () => setTimeout(() => process.exit(3), 50),
  log: (l) => console.error(`[sidecar] ${l}`),
});

// MCP servers start in the background (a first `npx` may download for a minute): the island is usable meanwhile (ADR-0025).
let mcp: McpConnections | undefined;
let closing = false;
if (Object.keys(config.mcp.servers).length > 0) {
  void connectMcpServers(config.mcp.servers, { env: process.env, plan: (c, a) => planSpawn(c, a), log: (l) => console.error(`[sidecar] ${l}`) }).then((c) => {
    if (closing) return c.close();
    mcp = c;
    runtime.addTools(c.tools, { mcp: c.servers });
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => server.handleLine(line));
rl.on("close", () => {
  closing = true;
  mcp?.close();
  server.close();
  if (traces instanceof SqliteTraceStore) traces.close();
  aliases?.close();
  instantStore?.close();
  memoryStore?.close();
  process.exit(0);
});
console.error(`[sidecar] ready (offline=${runtime.offline}, models=${runtime.models.join(",")}, traces=${traceDb ?? "memory"}, scannedApps=${scanned.length})`);
