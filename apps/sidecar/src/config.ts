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
  /** Instant layer (ADR-0015): fixed pleasantry replies and a receipt acknowledgement on long tasks. No model involved. */
  instantResponses: z.boolean().default(true),
  /** Semantic cache of verified answers to repeated questions (ADR-0015, R2). Needs a data dir to persist across runs. */
  instantCache: z
    .object({
      enabled: z.boolean().default(true),
      /** Verified model answers required before a question is served from cache. */
      minSeen: z.number().int().min(1).default(2),
      threshold: z.number().min(0.5).max(1).default(0.8),
      maxEntries: z.number().int().min(10).max(20_000).default(2_000),
      ttlDays: z.number().min(1).default(30),
    })
    .default({}),
  /** Learn how the user talks (register, preference for brevity) from aggregate counts and add a fixed-phrase hint to the prompt (ADR-0015, R3). */
  styleProfile: z.boolean().default(true),
  /**
   * Local speech-to-text for push-to-talk (ADR-0016). Needs a whisper.cpp CLI binary and a ggml model that YOU provide;
   * nothing is downloaded or built automatically. Audio never leaves the machine.
   */
  voice: z
    .object({
      /**
       * "auto": with GROQ_API_KEY and GEMINI_API_KEY, both run in parallel (fast whisper on Groq for clear commands, Gemini to
       * understand the rest); with one key, that one; local whisper.cpp is always the fallback. Cloud engines send audio OUT of the
       * machine (free tiers). "groq"/"gemini": only that cloud engine. "local": audio never leaves the machine (ADR-0020).
       */
      engine: z.enum(["auto", "groq", "gemini", "local"]).default("auto"),
      /** Groq-hosted whisper (fast literal transcription, ~0.5 s). */
      cloudModel: z.string().min(1).default("whisper-large-v3-turbo"),
      /** Gemini model that transcribes AND interprets what was meant (~1.4 s), used when the fast text is not a clear command. */
      understandModel: z.string().min(1).default("gemini-3.5-flash-lite"),
      /** Local whisper.cpp CLI and model (optional when the cloud engine is used). */
      binary: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      language: z.string().regex(/^(auto|[a-z]{2,3})$/).default("es"),
      threads: z.number().int().min(1).max(32).optional(),
      /** Words that wake the assistant (a transcript must START with one). */
      wakeWords: z.array(z.string().min(2).max(30)).min(1).max(5).default(["jarvis"]),
      /** Smaller/faster model for wake-word verification (e.g. ggml-tiny.bin); defaults to `model`. */
      wakeModel: z.string().min(1).optional(),
      /** Beam-search width: 5 is more accurate, 1 (greedy) is faster. */
      beamSize: z.number().int().min(1).max(10).default(5),
      /** Initial prompt that biases recognition toward your vocabulary. Default: built from your app names; "" turns it off. */
      prompt: z.string().max(300).optional(),
      timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
    })
    .optional(),
  /**
   * Coding agents (ADR-0023): JARVIS delegates programming to CLIs the user already has, cheapest first — Gemini CLI (free with a
   * Google account), then Claude Code (the user's Claude plan). A project's `verify` command decides whether the work is done.
   */
  coding: z
    .object({
      agents: z.array(z.enum(["gemini", "claude"])).min(1).default(["gemini", "claude"]),
      gemini: z.object({ binary: z.string().min(1).default("gemini"), model: z.string().min(1).optional(), approval: z.enum(["auto_edit", "yolo"]).default("auto_edit") }).default({}),
      claude: z.object({ binary: z.string().min(1).default("claude"), model: z.string().min(1).optional(), permissionMode: z.enum(["acceptEdits", "default", "bypassPermissions"]).default("acceptEdits") }).default({}),
      /** alias -> folder (and optional command whose success means "done", e.g. "pnpm test"). Agents never work outside these. */
      projects: z.record(z.object({ path: z.string().min(1), verify: z.string().min(1).optional() })).default({}),
      /** Used when the request names no project. Without it, a scratch workspace inside the data folder is used. */
      defaultProject: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(10_000).default(900_000),
      idleTimeoutMs: z.number().int().min(10_000).default(180_000),
    })
    .default({}),
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
    "visual studio code": "code",
    "visual studio": "code",
    "explorador de archivos": "explorer",
    "explorador": "explorer",
    "file explorer": "explorer",
    "administrador de tareas": "taskmgr",
    "task manager": "taskmgr",
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
