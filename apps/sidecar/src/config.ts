import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { ModelCapabilities } from "@jarvis/protocol";

const Models = z.array(ModelCapabilities).default([]);

/** Prices and latencies are the user's estimates; the sidecar never invents them. */
export const Config = z.object({
  defaultModel: z.string().optional(),
  /** SQLite file for execution traces. Overridden by JARVIS_DATA_DIR/traces.db when that env var is set. */
  traceDb: z.string().optional(),
  apps: z.record(z.string()).default({
    "vs code": "code",
    vscode: "code",
    notepad: "notepad",
    "bloc de notas": "notepad",
    calculator: "calc",
    calculadora: "calc",
    paint: "mspaint",
    navegador: "msedge",
    browser: "msedge",
    "otra pestana": "msedge",
    "nueva pestana": "msedge",
    "una pestana": "msedge",
    "new tab": "msedge",
  }),
  ollama: z.object({ baseUrl: z.string().url().optional(), models: Models }).optional(),
  anthropic: z.object({ models: Models }).optional(),
  openrouter: z.object({ models: Models }).optional(),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(path: string | undefined): Config {
  if (!path || !existsSync(path)) return Config.parse({});
  return Config.parse(JSON.parse(readFileSync(path, "utf8")));
}
