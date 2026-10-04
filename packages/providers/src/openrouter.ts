import type { ModelCapabilities } from "@jarvis/protocol";
import { OpenAICompatibleProvider } from "./openai-compat";
import type { FetchLike } from "./types";

export interface OpenRouterOptions {
  apiKey: string;
  models: ModelCapabilities[];
  baseUrl?: string;
  fetch?: FetchLike;
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(opts: OpenRouterOptions) {
    super({ ...opts, id: "openrouter", baseUrl: opts.baseUrl ?? "https://openrouter.ai/api/v1" });
  }
}
