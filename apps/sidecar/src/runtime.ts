import { PolicyEngine } from "@jarvis/policy";
import {
  AnthropicProvider,
  GoogleProvider,
  GroqProvider,
  FakeProvider,
  OllamaProvider,
  OpenRouterProvider,
  ProviderRegistry,
  type FetchLike,
} from "@jarvis/providers";
import { AlwaysCheapestRouter, AlwaysPremiumRouter, AppCatalog, IntentRouter, MemoryTraceStore, Orchestrator, ResponseHeuristicEvaluator, RuleInstantResponder, SemanticCache, StyleTracker, summarizeEconomy, instantControlRules, styleControlRules, RulesRouter, StaticRouter, type AliasStore, type InstantStore, type EventBus, type ModelRouter, type PermissionResolver, type TraceStore } from "@jarvis/core";
import type { EconomySummary } from "@jarvis/protocol";
import { WhisperCppTranscriber, type Transcriber } from "@jarvis/voice";
import {
  ToolRegistry,
  filesRead,
  filesWrite,
  makeAliasesForget,
  makeAliasesLearn,
  makeAliasesList,
  makeInstantClear,
  makeInstantForget,
  makeInstantList,
  makeInstantToggle,
  makeStyleReset,
  makeStyleShow,
  makeStyleToggle,
  makeAppsOpen,
  timeDate,
  timeNow,
  type AppLauncher,
} from "@jarvis/tools";
import type { ModelCapabilities } from "@jarvis/protocol";
import type { ScannedApp } from "./app-scanner";
import type { Config } from "./config";

/** Launches only what the catalog knows, accepting either the raw command or a name a person would say. */
export function makeCatalogLauncher(catalog: Pick<AppCatalog, "hasCommand" | "lookup">, launch: AppLauncher): AppLauncher {
  return async (nameOrCommand) => {
    const command = catalog.hasCommand(nameOrCommand) ? nameOrCommand : catalog.lookup(nameOrCommand);
    if (!command) throw new Error(`"${nameOrCommand}" is not a known app`);
    await launch(command);
  };
}

/**
 * Whisper conditions on an initial prompt: naming the apps the user can open makes "abre la calculadora" come out right
 * instead of as a phonetically similar word. Kept short, since long prompts get regurgitated on noise.
 */
export function defaultVoicePrompt(aliases: readonly string[], language: string): string | undefined {
  const names = aliases.filter((a) => /^[\p{L}\p{N} ]{2,25}$/u.test(a)).slice(0, 4);
  if (names.length === 0 || language === "en") return undefined;
  // One natural sentence (a list that repeats "abre" invites the model to loop on it).
  return `Jarvis, abre ${names.join(", ")}.`;
}

export const OFFLINE_MODEL = "offline-echo";

const offlineCaps: ModelCapabilities = {
  model: OFFLINE_MODEL,
  provider: "offline",
  supportsVision: false,
  supportsTools: false,
  supportsStreaming: true,
  contextWindow: 8_000,
  estimatedInputCost: 0,
  estimatedOutputCost: 0,
  expectedLatency: 0,
  isLocal: true,
};

export interface RuntimeDeps {
  env: Record<string, string | undefined>;
  launcher: AppLauncher;
  fetch?: FetchLike;
  /** Where execution traces go; defaults to an in-memory store. */
  traces?: TraceStore;
  /** Where learned aliases persist; in-memory when omitted. */
  aliases?: AliasStore;
  /** Where the semantic cache persists; in-memory when omitted. */
  instantStore?: InstantStore;
  /** Overrides the configured speech-to-text engine (tests). */
  transcriber?: Transcriber;
  /** Apps discovered on the machine; lowest-priority aliases. */
  scanned?: ScannedApp[];
}

export interface Runtime {
  providers: ProviderRegistry;
  models: string[];
  offline: boolean;
  /** Present when `voice` is configured (or injected for tests). */
  transcriber?: Transcriber;
  /** Lighter engine for wake-word verification (config.voice.wakeModel). */
  wakeTranscriber?: Transcriber;
  wakeWords: readonly string[];
  /** AI Economy aggregate over the stored traces; undefined if the store cannot list. */
  economy(limit: number): EconomySummary | undefined;
  createOrchestrator(io: { bus: EventBus; askPermission: PermissionResolver }): Orchestrator;
}

/** Wires config + environment into the core. Cloud providers require their API key. */
export function buildRuntime(config: Config, deps: RuntimeDeps): Runtime {
  const providers = new ProviderRegistry();
  const key = (...names: string[]): string => {
    const v = names.map((n) => deps.env[n]).find(Boolean);
    if (!v) throw new Error(`${names.join(" or ")} is required because the config enables that provider`);
    return v;
  };

  if (config.ollama) providers.register(new OllamaProvider({ baseUrl: config.ollama.baseUrl, models: config.ollama.models, fetch: deps.fetch }));
  if (config.anthropic) providers.register(new AnthropicProvider({ apiKey: key("ANTHROPIC_API_KEY"), models: config.anthropic.models, fetch: deps.fetch }));
  if (config.openrouter) providers.register(new OpenRouterProvider({ apiKey: key("OPENROUTER_API_KEY"), models: config.openrouter.models, fetch: deps.fetch }));

  if (config.groq) providers.register(new GroqProvider({ apiKey: key("GROQ_API_KEY"), models: config.groq.models, fetch: deps.fetch }));
  if (config.google) providers.register(new GoogleProvider({ apiKey: key("GEMINI_API_KEY", "GOOGLE_API_KEY"), models: config.google.models, fetch: deps.fetch }));

  if (config.freeOnly) {
    const paid = providers.capabilities().filter((c) => c.estimatedInputCost > 0 || c.estimatedOutputCost > 0);
    if (paid.length) throw new Error(`freeOnly is set but these models have a price: ${paid.map((c) => c.model).join(", ")}`);
  }

  let models = providers.capabilities().map((c) => c.model);
  const offline = models.length === 0;
  if (offline) {
    providers.register(
      new FakeProvider("offline", [offlineCaps], (req) => {
        const last = req.messages.at(-1)?.content ?? "";
        return `[offline-echo — no hay proveedor configurado] ${last}`;
      }),
    );
    models = [OFFLINE_MODEL];
  }

  const defaultModel = config.defaultModel ?? models[0]!;
  if (!models.includes(defaultModel)) throw new Error(`defaultModel "${defaultModel}" is not offered by any configured provider`);

  const catalog = new AppCatalog(deps.aliases);
  for (const [alias, command] of Object.entries(config.apps)) catalog.add(alias, command, "config");
  for (const a of deps.scanned ?? []) catalog.add(a.alias, a.command, "scan");
  catalog.restore();

  // Only commands the catalog knows can be launched, whoever asks (local intent or model).
  // The model (or a transcript) may pass the name a person would say ("calculator", "bloc de notas") rather than the raw
  // command ("calc"): resolve names through the catalog first. Anything the catalog does not know is still refused.
  const launcher = makeCatalogLauncher(catalog, deps.launcher);
  const knownAppNames = Object.keys(config.apps).slice(0, 25);
  const cache = new SemanticCache({
    store: deps.instantStore,
    enabled: config.instantCache.enabled,
    minSeen: config.instantCache.minSeen,
    threshold: config.instantCache.threshold,
    maxEntries: config.instantCache.maxEntries,
    ttlMs: config.instantCache.ttlDays * 86_400_000,
  });
  // The profile shares the cache's store (aggregate counters only) so one data file holds what the assistant has learned.
  const style = new StyleTracker({ store: deps.instantStore, enabled: config.styleProfile });
  const tools = new ToolRegistry()
    .register(timeNow)
    .register(timeDate)
    .register(filesRead)
    .register(filesWrite)
    .register(makeAppsOpen(launcher, knownAppNames))
    .register(makeAliasesLearn(catalog))
    .register(makeAliasesForget(catalog))
    .register(makeAliasesList(catalog))
    .register(makeInstantList(cache))
    .register(makeInstantForget(cache))
    .register(makeInstantClear(cache))
    .register(makeInstantToggle(cache))
    .register(makeStyleShow(style))
    .register(makeStyleReset(style))
    .register(makeStyleToggle(style));
  const makeRouter = (): ModelRouter =>
    config.router === "always_premium"
      ? new AlwaysPremiumRouter()
      : config.router === "always_cheapest"
        ? new AlwaysCheapestRouter()
        : config.router === "rules"
          ? new RulesRouter()
          : new StaticRouter(defaultModel);
  const traces = deps.traces ?? new MemoryTraceStore();

  const transcriber =
    deps.transcriber ??
    (config.voice
      ? new WhisperCppTranscriber({ binary: config.voice.binary, model: config.voice.model, language: config.voice.language, threads: config.voice.threads, timeoutMs: config.voice.timeoutMs, beamSize: config.voice.beamSize, prompt: config.voice.prompt ?? defaultVoicePrompt(Object.keys(config.apps), config.voice.language) })
      : undefined);

  const wakeTranscriber =
    config.voice?.wakeModel && !deps.transcriber
      ? new WhisperCppTranscriber({ binary: config.voice.binary, model: config.voice.wakeModel, language: config.voice.language, threads: config.voice.threads, timeoutMs: config.voice.timeoutMs, beamSize: 1, prompt: "Jarvis." })
      : undefined;

  return {
    providers,
    ...(transcriber ? { transcriber } : {}),
    ...(wakeTranscriber ? { wakeTranscriber } : {}),
    wakeWords: config.voice?.wakeWords ?? ["jarvis"],
    models,
    offline,
    economy: (limit) => (traces.list ? summarizeEconomy(traces.list(limit)) : undefined),
    createOrchestrator: ({ bus, askPermission }) =>
      new Orchestrator({
        bus,
        intents: new IntentRouter({ apps: catalog, rules: [...instantControlRules, ...styleControlRules] }),
        ...(config.instantResponses ? { instant: new RuleInstantResponder(), cache } : {}),
        style,
        router: makeRouter(),
        providers,
        tools,
        policy: new PolicyEngine(),
        askPermission,
        traces,
        evaluators: [new ResponseHeuristicEvaluator()],
        maxEscalations: config.maxEscalations,
      }),
  };
}
