import type { ModelCapabilities } from "@jarvis/protocol";
import { OpenAICompatibleProvider } from "./openai-compat";
import type { FetchLike } from "./types";

export interface GroqOptions {
  apiKey: string;
  models: ModelCapabilities[];
  baseUrl?: string;
  fetch?: FetchLike;
}

/** Groq's OpenAI-compatible endpoint: fast open-weight models with a generous free tier (RPM/RPD/TPM/TPD limits per model). */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor(opts: GroqOptions) {
    super({ ...opts, id: "groq", baseUrl: opts.baseUrl ?? "https://api.groq.com/openai/v1" });
  }
}
