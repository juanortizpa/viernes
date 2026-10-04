import type { ModelCapabilities } from "@jarvis/protocol";
import { ProviderError, type FetchLike, type GenerateRequest, type Provider, type ProviderChunk } from "./types";
import { estimateCostUsd, readLines, sseData } from "./util";

export interface AnthropicOptions {
  apiKey: string;
  models: ModelCapabilities[];
  baseUrl?: string;
  fetch?: FetchLike;
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  constructor(private readonly opts: AnthropicOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.fetch = opts.fetch ?? fetch;
  }

  capabilities(): ModelCapabilities[] {
    return this.opts.models;
  }

  async *generate(req: GenerateRequest): AsyncGenerator<ProviderChunk> {
    if (req.tools?.length) throw new ProviderError("tool calling is not implemented for this adapter", this.id);
    const caps = this.opts.models.find((m) => m.model === req.model);
    if (!caps) throw new ProviderError(`unknown model ${req.model}`, this.id);
    const start = Date.now();
    let firstToken: number | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cached = 0;
    const res = await this.fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        system: req.system,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 1024,
        stream: true,
      }),
      signal: req.signal,
    });
    for await (const line of readLines(res, this.id)) {
      const data = sseData(line);
      if (data === undefined) continue;
      const j = JSON.parse(data) as {
        type: string;
        delta?: { type?: string; text?: string };
        message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number } };
        usage?: { output_tokens?: number };
        error?: { message?: string };
      };
      if (j.type === "error") throw new ProviderError(j.error?.message ?? "stream error", this.id);
      if (j.type === "message_start") {
        inputTokens = j.message?.usage?.input_tokens ?? 0;
        cached = j.message?.usage?.cache_read_input_tokens ?? 0;
      } else if (j.type === "content_block_delta" && j.delta?.type === "text_delta" && j.delta.text) {
        firstToken ??= Date.now() - start;
        yield { type: "delta", text: j.delta.text };
      } else if (j.type === "message_delta") {
        outputTokens = j.usage?.output_tokens ?? outputTokens;
      }
    }
    yield {
      type: "done",
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens: cached,
        estimatedCostUsd: estimateCostUsd(caps, inputTokens, outputTokens),
        latencyMs: Date.now() - start,
        timeToFirstTokenMs: firstToken,
      },
    };
  }
}
