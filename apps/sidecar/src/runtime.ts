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
import { AlwaysCheapestRouter, AlwaysPremiumRouter, AppCatalog, ConversationMemory, IntentRouter, MemoryBook, conversationControlRules, memoryControlRules, MemoryTraceStore, Orchestrator, ResponseHeuristicEvaluator, RuleInstantResponder, SemanticCache, StyleTracker, summarizeEconomy, instantControlRules, styleControlRules, RulesRouter, StaticRouter, type AliasStore, type InstantStore, type MemoryStore, type EventBus, type ModelRouter, type PermissionResolver, type TraceStore } from "@jarvis/core";
import type { EconomySummary } from "@jarvis/protocol";
import { FallbackTranscriber, GeminiTranscriber, GroqTranscriber, RaceTranscriber, WhisperCppTranscriber, type Transcriber } from "@jarvis/voice";
import {
  ToolRegistry,
  filesRead,
  filesWrite,
  makeAliasesForget,
  makeAliasesLearn,
  makeAliasesList,
  makeConversationClear,
  makeMemoryAdd,
  makeMemoryClear,
  makeMemoryForget,
  makeMemoryList,
  makeMemoryToggle,
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
import { Config } from "./config";
import type { MemoryControl } from "./server";

/** Launches only what the catalog knows, accepting either the raw command or a name a person would say. */
export function makeCatalogLauncher(catalog: Pick<AppCatalog, "hasCommand" | "lookup" | "suggest">, launch: AppLauncher): AppLauncher {
  return async (nameOrCommand) => {
    // Exact command, then a known name, then ONE unambiguous sounds-like match (a misheard name from voice).
    const command = catalog.hasCommand(nameOrCommand) ? nameOrCommand : (catalog.lookup(nameOrCommand) ?? catalog.suggest(nameOrCommand)?.command);
    if (!command) throw new Error(`"${nameOrCommand}" is not a known app`);
    await launch(command);
  };
}

/**
 * Whisper's initial prompt. MEASURED (ADR-0020): a list of app names gets regurgitated — "jarvis, abre paint" came back as
 * "Jarvis, abre la calculadora, el navegador, Teams." — which would open the WRONG app. So only the assistant's name is primed;
 * app vocabulary is handled after recognition (phonetic matching, the interpreter, the model).
 */
export function defaultVoicePrompt(_aliases: readonly string[], language: string): string | undefined {
  return language === "en" ? undefined : "Jarvis.";
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
  /** Where long-term memory persists; in-memory when omitted. */
  memoryStore?: MemoryStore;
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
  /** Speech engines in the order they are tried, e.g. ["groq:whisper-large-v3-turbo", "local"]. */
  voiceEngines: string[];
  /** The user's view and control of long-term memory, for the UI (ADR-0023). */
  memory: MemoryControl;
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
  // Working memory of the chat and the facts the user asked to keep (ADR-0023). One sidecar serves one connection (ADR-0008), so
  // sharing these across `createOrchestrator` calls is the same as per connection.
  const conversation = new ConversationMemory({
    enabled: config.memory.conversation.enabled,
    maxTurns: config.memory.conversation.maxTurns,
    idleMs: config.memory.conversation.idleMinutes * 60_000,
  });
  const memory = new MemoryBook({ store: deps.memoryStore, enabled: config.memory.longTerm.enabled, maxItems: config.memory.longTerm.maxItems, minScore: config.memory.longTerm.minScore });
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
    .register(makeStyleToggle(style))
    .register(makeMemoryAdd(memory))
    .register(makeMemoryList(memory))
    .register(makeMemoryForget(memory, { alsoForget: () => conversation.clear() }))
    .register(makeMemoryClear(memory, { alsoForget: () => conversation.clear() }))
    .register(makeMemoryToggle(memory))
    .register(makeConversationClear(conversation));
  const controlRules = [...instantControlRules, ...styleControlRules, ...conversationControlRules, ...memoryControlRules];
  const makeRouter = (): ModelRouter =>
    config.router === "always_premium"
      ? new AlwaysPremiumRouter()
      : config.router === "always_cheapest"
        ? new AlwaysCheapestRouter()
        : config.router === "rules"
          ? new RulesRouter()
          : new StaticRouter(defaultModel);
  const traces = deps.traces ?? new MemoryTraceStore();

  // Speech-to-text engines (ADR-0020). The voice section is optional: with a Groq key and no local setup, cloud STT still works.
  const v = config.voice ?? Config.shape.voice.unwrap().parse({});
  const vPrompt = v.prompt ?? defaultVoicePrompt(Object.keys(config.apps), v.language);
  const local =
    v.engine !== "groq" && v.binary && v.model
      ? new WhisperCppTranscriber({ binary: v.binary, model: v.model, language: v.language, threads: v.threads, timeoutMs: v.timeoutMs, beamSize: v.beamSize, prompt: vPrompt })
      : undefined;
  const groqKey = v.engine === "auto" || v.engine === "groq" ? deps.env.GROQ_API_KEY : undefined;
  const geminiKey = v.engine === "auto" || v.engine === "gemini" ? (deps.env.GEMINI_API_KEY ?? deps.env.GOOGLE_API_KEY) : undefined;
  const fetchImpl = deps.fetch as typeof fetch | undefined;
  const groq = groqKey ? new GroqTranscriber({ apiKey: groqKey, model: v.cloudModel, language: v.language, prompt: vPrompt, fetch: fetchImpl }) : undefined;
  const gemini = geminiKey ? new GeminiTranscriber({ apiKey: geminiKey, model: v.understandModel, vocabulary: Object.keys(config.apps).slice(0, 20), fetch: fetchImpl }) : undefined;
  // Fast path: a transcript that the deterministic router already maps to a local command needs no interpretation.
  const quickRouter = new IntentRouter({ apps: AppCatalog.fromRecord(config.apps), rules: controlRules });
  const isClearCommand = (text: string): boolean => {
    const r = quickRouter.resolve(text);
    return r.route === "local" && r.confidence === 1;
  };
  const cloudEngine: { name: string; engine: Transcriber } | undefined =
    groq && gemini
      ? { name: `groq:${v.cloudModel}+gemini:${v.understandModel}`, engine: new RaceTranscriber({ fast: groq, accurate: gemini, acceptFast: isClearCommand, accurateTimeoutMs: 2_500 }) }
      : groq
        ? { name: `groq:${v.cloudModel}`, engine: groq }
        : gemini
          ? { name: `gemini:${v.understandModel}`, engine: gemini }
          : undefined;
  const engines = [...(cloudEngine ? [cloudEngine] : []), ...(local ? [{ name: "local", engine: local as Transcriber }] : [])];
  const transcriber = deps.transcriber ?? (engines.length ? new FallbackTranscriber(engines, { onFallback: (from, why) => console.error(`[sidecar] STT ${from} failed (${why}); falling back`) }) : undefined);
  const voiceEngines = deps.transcriber ? ["injected"] : engines.map((e) => e.name);

  // Wake-word verification needs the LITERAL words ("jarvis …"), fast: local tiny model, else Groq's whisper (never the interpreter).
  const wakeTranscriber = deps.transcriber
    ? undefined
    : v.wakeModel && v.binary && v.engine !== "groq" && v.engine !== "gemini"
      ? new WhisperCppTranscriber({ binary: v.binary, model: v.wakeModel, language: v.language, threads: v.threads, timeoutMs: v.timeoutMs, beamSize: 1, prompt: "Jarvis." })
      : groq
        ? new GroqTranscriber({ apiKey: groqKey!, model: v.cloudModel, language: v.language, prompt: "Jarvis.", fetch: fetchImpl })
        : undefined;

  return {
    providers,
    ...(transcriber ? { transcriber } : {}),
    ...(wakeTranscriber ? { wakeTranscriber } : {}),
    wakeWords: v.wakeWords,
    voiceEngines,
    models,
    offline,
    memory: {
      snapshot: () => ({
        enabled: memory.enabled,
        conversationTurns: conversation.size(),
        items: memory.list().map((i) => ({ id: i.id, kind: i.kind, text: i.text, createdAt: i.createdAt, uses: i.uses, ...(i.usedAt !== undefined ? { usedAt: i.usedAt } : {}) })),
      }),
      // From the panel too: the conversation may still hold what is being forgotten.
      forget: (id) => (memory.forget(id).ok ? void conversation.clear() : undefined),
      clear: () => void (memory.clear(), conversation.clear()),
      setEnabled: (enabled) => memory.setEnabled(enabled),
    },
    economy: (limit) => (traces.list ? summarizeEconomy(traces.list(limit)) : undefined),
    createOrchestrator: ({ bus, askPermission }) =>
      new Orchestrator({
        bus,
        intents: new IntentRouter({ apps: catalog, rules: controlRules }),
        ...(config.instantResponses ? { instant: new RuleInstantResponder(), cache } : {}),
        style,
        conversation,
        memory,
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
