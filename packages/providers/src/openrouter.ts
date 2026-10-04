import type { ModelCapabilities } from "@jarvis/protocol";
import { ProviderError, type FetchLike, type GenerateRequest, type Provider, type ProviderChunk } from "./types";
import { estimateCostUsd, readLines, sseData } from "./util";

export interface OpenRouterOptions {
  apiKey: string;
  models: ModelCapabilities[];
  baseUrl?: string;
  fetch?: FetchLike;
}

/** OpenAI-compatible chat completions over SSE. */
export class OpenRouterProvider implements Provider {
  readonly id = "openrouter";
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  constructor(private readonly opts: OpenRouterOptions) {
    this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
    this.fetch = opts.fetch ?? fetch;
  }

  capabilities(): ModelCapabilities[] {
    return this.opts.models;
  }

  async *generate(req: GenerateRequest): AsyncGenerator<ProviderChunk> {
    const caps = this.opts.models.find((m) => m.model === req.model);
    if (!caps) throw new ProviderError(`unknown model ${req.model}`, this.id);
    const start = Date.now();
    let firstToken: number | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages];
    const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxTokens,
      }),
      signal: req.signal,
    });
    for await (const line of readLines(res, this.id)) {
      const data = sseData(line);
      if (data === undefined || data === "[DONE]") continue;
      const j = JSON.parse(data) as {
        choices?: { delta?: { content?: string } }[];
        usage?: typeof usage;
        error?: { message?: string };
      };
      if (j.error) throw new ProviderError(j.error.message ?? "stream error", this.id);
      const text = j.choices?.[0]?.delta?.content;
      if (text) {
        firstToken ??= Date.now() - start;
        yield { type: "delta", text };
      }
      if (j.usage) usage = j.usage;
    }
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    yield {
      type: "done",
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        estimatedCostUsd: estimateCostUsd(caps, inputTokens, outputTokens),
        latencyMs: Date.now() - start,
        timeToFirstTokenMs: firstToken,
      },
    };
  }
}
