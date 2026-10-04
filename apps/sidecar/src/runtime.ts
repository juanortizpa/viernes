import { PolicyEngine } from "@jarvis/policy";
import {
  AnthropicProvider,
  FakeProvider,
  OllamaProvider,
  OpenRouterProvider,
  ProviderRegistry,
  type FetchLike,
} from "@jarvis/providers";
import { AppCatalog, IntentRouter, MemoryTraceStore, Orchestrator, StaticRouter, type AliasStore, type EventBus, type PermissionResolver, type TraceStore } from "@jarvis/core";
import {
  ToolRegistry,
  filesRead,
  filesWrite,
  makeAliasesForget,
  makeAliasesLearn,
  makeAliasesList,
  makeAppsOpen,
  timeDate,
  timeNow,
  type AppLauncher,
} from "@jarvis/tools";
import type { ModelCapabilities } from "@jarvis/protocol";
import type { ScannedApp } from "./app-scanner";
import type { Config } from "./config";

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
  /** Apps discovered on the machine; lowest-priority aliases. */
  scanned?: ScannedApp[];
}

export interface Runtime {
  providers: ProviderRegistry;
  models: string[];
  offline: boolean;
  createOrchestrator(io: { bus: EventBus; askPermission: PermissionResolver }): Orchestrator;
}

/** Wires config + environment into the core. Cloud providers require their API key. */
export function buildRuntime(config: Config, deps: RuntimeDeps): Runtime {
  const providers = new ProviderRegistry();
  const key = (name: string): string => {
    const v = deps.env[name];
    if (!v) throw new Error(`${name} is required because the config enables that provider`);
    return v;
  };

  if (config.ollama) providers.register(new OllamaProvider({ baseUrl: config.ollama.baseUrl, models: config.ollama.models, fetch: deps.fetch }));
  if (config.anthropic) providers.register(new AnthropicProvider({ apiKey: key("ANTHROPIC_API_KEY"), models: config.anthropic.models, fetch: deps.fetch }));
  if (config.openrouter) providers.register(new OpenRouterProvider({ apiKey: key("OPENROUTER_API_KEY"), models: config.openrouter.models, fetch: deps.fetch }));

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
  const launcher: AppLauncher = async (command) => {
    if (!catalog.hasCommand(command)) throw new Error(`"${command}" is not a known app`);
    await deps.launcher(command);
  };
  const tools = new ToolRegistry()
    .register(timeNow)
    .register(timeDate)
    .register(filesRead)
    .register(filesWrite)
    .register(makeAppsOpen(launcher))
    .register(makeAliasesLearn(catalog))
    .register(makeAliasesForget(catalog))
    .register(makeAliasesList(catalog));
  const traces = deps.traces ?? new MemoryTraceStore();

  return {
    providers,
    models,
    offline,
    createOrchestrator: ({ bus, askPermission }) =>
      new Orchestrator({
        bus,
        intents: new IntentRouter({ apps: catalog }),
        router: new StaticRouter(defaultModel),
        providers,
        tools,
        policy: new PolicyEngine(),
        askPermission,
        traces,
      }),
  };
}
