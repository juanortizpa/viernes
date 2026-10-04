import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { ModelCapabilities } from "@jarvis/protocol";

const Models = z.array(ModelCapabilities).default([]);

/** Prices and latencies are the user's estimates; the sidecar never invents them. */
export const Config = z.object({
  defaultModel: z.string().optional(),
  /** Model routing strategy (ADR-0011). "static" always uses defaultModel. */
  router: z.enum(["static", "always_premium", "always_cheapest", "rules"]).default("static"),
  /** SQLite file for execution traces. Overridden by JARVIS_DATA_DIR/traces.db when that env var is set. */
  traceDb: z.string().optional(),
  /** How many times a failed/uncertain answer may move up to the next, stronger model (cascade, ADR-0011). 0 disables it. */
  maxEscalations: z.number().int().min(0).max(3).default(1),
  /** Refuse to start if any configured model has a non-zero price. */
  freeOnly: z.boolean().default(false),
  /** Discover installed apps (Windows Start Menu) so "abre X" works without hand-written aliases. */
  scanApps: z.boolean().default(true),
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
  /** Needs GROQ_API_KEY. OpenAI-compatible; free tier has per-model RPM/RPD/TPM/TPD limits. */
  groq: z.object({ models: Models }).optional(),
  /** Google AI Studio (Gemini API). Needs GEMINI_API_KEY (or GOOGLE_API_KEY). */
  google: z.object({ models: Models }).optional(),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(path: string | undefined): Config {
  if (!path || !existsSync(path)) return Config.parse({});
  return Config.parse(JSON.parse(readFileSync(path, "utf8")));
}
