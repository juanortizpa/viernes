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
import { AlwaysCheapestRouter, AlwaysPremiumRouter, AppCatalog, ConversationMemory, FillerPolicy, ModelHealth, IntentRouter, MemoryBook, conversationControlRules, memoryControlRules, MemoryTraceStore, Orchestrator, ResponseHeuristicEvaluator, RuleInstantResponder, SemanticCache, StyleTracker, summarizeEconomy, instantControlRules, styleControlRules, RulesRouter, StaticRouter, type AliasStore, type InstantStore, type MemoryStore, type EventBus, type ModelRouter, type PermissionResolver, type TraceStore } from "@jarvis/core";
import type { EconomySummary } from "@jarvis/protocol";
import { FallbackTranscriber, GeminiTranscriber, GroqTranscriber, RaceTranscriber, WhisperCppTranscriber, type Transcriber, type Transcript } from "@jarvis/voice";
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
  makeWebFetch,
  makeWebSearch,
  timeDate,
  timeNow,
  type AnyTool,
  type AppLauncher,
} from "@jarvis/tools";
import type { McpServerStatus } from "@jarvis/mcp";
import type { ModelCapabilities } from "@jarvis/protocol";
import type { ScannedApp } from "./app-scanner";
import { Config } from "./config";
import { tmpdir as tmpdirOs } from "node:os";
import { capabilitiesRule, makeCapabilitiesTool, routineInvalidTool } from "./capabilities";
import { checkRoutines, routineRule } from "./routines";
import { availableAgents, codingControlRule, codingIntentRule, makeCodeAgentTool, makeCodeChangesTool, makeCodeUndoTool, type CodingSession } from "./coding";
import { join as joinPath } from "node:path";
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
  /** Folder for agent work that belongs to no project (scripts). Defaults to the OS temp dir. */
  workspace?: string;
  /** Overrides agent discovery (tests). */
  codingAgents?: () => import("@jarvis/agents").CodingAgent[];
  /** Where long-term memory persists; in-memory when omitted. */
  memoryStore?: MemoryStore;
  /** Overrides the configured speech-to-text engine (tests). */
  transcriber?: Transcriber;
  /** Engine for live partials while streaming (tests); defaults to Groq's whisper when configured. */
  partialTranscriber?: Transcriber;
  /** Apps discovered on the machine; lowest-priority aliases. */
  scanned?: ScannedApp[];
}

export interface Runtime {
  providers: ProviderRegistry;
  models: string[];
  offline: boolean;
  /** Present when `voice` is configured (or injected for tests). */
  transcriber?: Transcriber;
  /** Streaming voice: partial engine, acceptance policy, speculation (ADR-0029). */
  streaming: { partial?: Transcriber; accept: (t: Transcript) => boolean; speculate: boolean; worthSpeculating: (text: string) => boolean; allowPartial: () => boolean };
  /** Lighter engine for wake-word verification (config.voice.wakeModel). */
  wakeTranscriber?: Transcriber;
  wakeWords: readonly string[];
  /** Speech engines in the order they are tried, e.g. ["groq:whisper-large-v3-turbo", "local"]. */
  voiceEngines: string[];
  /** The user's view and control of long-term memory, for the UI (ADR-0023). */
  memory: MemoryControl;
  /** Configuration problems worth logging at start-up (e.g. a routine step that needs a model). */
  warnings: string[];
  /** AI Economy aggregate over the stored traces; undefined if the store cannot list. */
  economy(limit: number): EconomySummary | undefined;
  /**
   * Tools that arrive after start-up (MCP servers connect in the background, ADR-0025). The orchestrator reads the registry on every
   * model attempt, so they are offered from the next request on. Returns the names actually added.
   */
  addTools(tools: readonly AnyTool[], source?: { mcp?: McpServerStatus[] }): string[];
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
  const workspace = deps.workspace ?? joinPath(tmpdirOs(), "jarvis-workspace");
  const coding: CodingSession = {};
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
    .register(makeCodeAgentTool(config.coding, workspace, deps.codingAgents, coding))
    .register(makeCodeChangesTool(config.coding, workspace, coding))
    .register(makeCodeUndoTool(config.coding, workspace, coding))
    .register(makeMemoryAdd(memory))
    .register(makeMemoryList(memory))
    .register(makeMemoryForget(memory, { alsoForget: () => conversation.clear() }))
    .register(makeMemoryClear(memory, { alsoForget: () => conversation.clear() }))
    .register(makeMemoryToggle(memory))
    .register(makeConversationClear(conversation));
  if (config.web.search) tools.register(makeWebSearch({ ...(deps.fetch ? { fetch: deps.fetch as never } : {}) }));
  if (config.web.fetch) tools.register(makeWebFetch({ ...(deps.fetch ? { fetch: deps.fetch as never } : {}) }));
  const controlRules = [...instantControlRules, ...styleControlRules, ...conversationControlRules, ...memoryControlRules, codingControlRule, capabilitiesRule];
  // Routine steps are resolved like typed commands, minus routines themselves (no recursion) and never by a model (ADR-0027).
  const stepRouter = new IntentRouter({ apps: catalog, rules: [...controlRules, codingIntentRule] });
  const resolveStep = (text: string) => stepRouter.resolve(text);
  const warnings = checkRoutines(config.routines, resolveStep);
  tools
    .register(routineInvalidTool)
    .register(
      makeCapabilitiesTool(() => ({
        models: offline ? [] : models,
        offline,
        apps: catalog.appCount(),
        projects: Object.keys(config.coding.projects),
        codingAgents: (deps.codingAgents?.() ?? availableAgents(config.coding)).map((a) => (a.name === "gemini" ? "Gemini CLI" : a.name === "claude" ? "Claude Code" : a.name)),
        routines: Object.keys(config.routines),
        mcp: status.mcp,
        voice: voiceEngines,
        memory: memory.enabled,
        web: [...(config.web.search ? ["buscar en internet"] : []), ...(config.web.fetch ? ["leer páginas"] : [])],
      })),
    );
  const makeRouter = (): ModelRouter =>
    config.router === "always_premium"
      ? new AlwaysPremiumRouter()
      : config.router === "always_cheapest"
        ? new AlwaysCheapestRouter()
        : config.router === "rules"
          ? new RulesRouter()
          : new StaticRouter(defaultModel);
  const traces = deps.traces ?? new MemoryTraceStore();
  /** Learned per-model availability and speed, shared by every orchestrator of this process (ADR-0029). */
  const health = new ModelHealth();
  const fillers = (config.voice ?? Config.shape.voice.unwrap().parse({})).fillers ? new FillerPolicy() : undefined;
  /** What is connected right now, for "¿qué podés hacer?". */
  const status: { mcp: McpServerStatus[] } = { mcp: [] };

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
  // When the fast transcript (Groq, ~0.4 s) can be acted on without waiting for Gemini's interpretation (~1.4 s). MEASURED on the
  // user's own 35 recordings (ADR-0029): "it maps to a local command, or whisper's confidence >= 0.7" got 31/35 actions right at a
  // median of 431 ms, vs 30/35 at 1206 ms for "only clear local commands"; thresholds 0.65-0.8 all gave 31 (a plateau, not a fit).
  const quickRouter = new IntentRouter({ apps: catalog, rules: [...controlRules, codingIntentRule] });
  const isLocal = (text: string): boolean => quickRouter.resolve(text).route === "local";
  const acceptFast = (t: Pick<Transcript, "text" | "confidence">): boolean => isLocal(t.text) || (t.confidence ?? 0) >= v.fastAcceptConfidence;
  const cloudEngine: { name: string; engine: Transcriber } | undefined =
    groq && gemini
      ? { name: `groq:${v.cloudModel}+gemini:${v.understandModel}`, engine: new RaceTranscriber({ fast: groq, accurate: gemini, acceptFast: (_text, t) => acceptFast(t), accurateTimeoutMs: 2_500 }) }
      : groq
        ? { name: `groq:${v.cloudModel}`, engine: groq }
        : gemini
          ? { name: `gemini:${v.understandModel}`, engine: gemini }
          : undefined;
  const engines = [...(cloudEngine ? [cloudEngine] : []), ...(local ? [{ name: "local", engine: local as Transcriber }] : [])];
  const transcriber = deps.transcriber ?? (engines.length ? new FallbackTranscriber(engines, { onFallback: (from, why) => console.error(`[sidecar] STT ${from} failed (${why}); falling back`) }) : undefined);
  const voiceEngines = deps.transcriber ? ["injected"] : engines.map((e) => e.name);
  // Partials while the user talks use the fast engine alone, within a per-minute budget that leaves room for the final transcripts
  // (Groq's free whisper allows 20 requests/min).
  const partialEngine = deps.partialTranscriber ?? (v.streaming && !deps.transcriber ? groq : undefined);
  const partialCalls: number[] = [];
  const streaming = {
    ...(partialEngine ? { partial: partialEngine } : {}),
    accept: acceptFast,
    speculate: v.speculate,
    worthSpeculating: (text: string) => !isLocal(text) && text.trim().split(/\s+/).length >= 2,
    allowPartial: () => {
      const t = Date.now();
      while (partialCalls.length && partialCalls[0]! < t - 60_000) partialCalls.shift();
      if (partialCalls.length >= v.partialsPerMinute) return false;
      partialCalls.push(t);
      return true;
    },
  };

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
    streaming,
    voiceEngines,
    models,
    offline,
    warnings,
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
    addTools: (list, source) => {
      if (source?.mcp) status.mcp = source.mcp;
      const added: string[] = [];
      for (const t of list) {
        if (tools.get(t.name)) continue; // never replace a built-in or an earlier server's tool
        tools.register(t);
        added.push(t.name);
      }
      return added;
    },
    createOrchestrator: ({ bus, askPermission }) =>
      new Orchestrator({
        bus,
        intents: new IntentRouter({ apps: catalog, rules: [...controlRules, codingIntentRule, routineRule(config.routines, resolveStep)] }),
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
        maxToolSteps: config.maxToolSteps,
        health,
        ...(fillers ? { fillers } : {}),
      }),
  };
}
