import { PolicyEngine } from "@jarvis/policy";
import {
  AnthropicProvider,
  FakeProvider,
  OllamaProvider,
  OpenRouterProvider,
  ProviderRegistry,
  type FetchLike,
} from "@jarvis/providers";
import { IntentRouter, MemoryTraceStore, Orchestrator, StaticRouter, type EventBus, type PermissionResolver } from "@jarvis/core";
import { ToolRegistry, filesRead, filesWrite, makeAppsOpen, timeNow, type AppLauncher } from "@jarvis/tools";
import type { ModelCapabilities } from "@jarvis/protocol";
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

  const tools = new ToolRegistry().register(timeNow).register(filesRead).register(filesWrite).register(makeAppsOpen(deps.launcher));
  const traces = new MemoryTraceStore();

  return {
    providers,
    models,
    offline,
    createOrchestrator: ({ bus, askPermission }) =>
      new Orchestrator({
        bus,
        intents: new IntentRouter({ apps: config.apps }),
        router: new StaticRouter(defaultModel),
        providers,
        tools,
        policy: new PolicyEngine(),
        askPermission,
        traces,
      }),
  };
}
