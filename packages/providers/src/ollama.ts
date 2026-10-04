import type { ModelCapabilities } from "@jarvis/protocol";
import { ProviderError, type FetchLike, type GenerateRequest, type Provider, type ProviderChunk } from "./types";
import { readLines } from "./util";

export interface OllamaOptions {
  baseUrl?: string;
  models: ModelCapabilities[];
  fetch?: FetchLike;
}

export class OllamaProvider implements Provider {
  readonly id = "ollama";
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  constructor(private readonly opts: OllamaOptions) {
    this.baseUrl = opts.baseUrl ?? "http://localhost:11434";
    this.fetch = opts.fetch ?? fetch;
  }

  capabilities(): ModelCapabilities[] {
    return this.opts.models;
  }

  async *generate(req: GenerateRequest): AsyncGenerator<ProviderChunk> {
    const start = Date.now();
    let firstToken: number | undefined;
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages];
    const res = await this.fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages,
        stream: true,
        options: req.maxTokens ? { num_predict: req.maxTokens } : undefined,
      }),
      signal: req.signal,
    });
    for await (const line of readLines(res, this.id)) {
      const j = JSON.parse(line) as {
        message?: { content?: string };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
        error?: string;
      };
      if (j.error) throw new ProviderError(j.error, this.id);
      if (j.message?.content) {
        firstToken ??= Date.now() - start;
        yield { type: "delta", text: j.message.content };
      }
      if (j.done) {
        yield {
          type: "done",
          usage: {
            inputTokens: j.prompt_eval_count ?? 0,
            outputTokens: j.eval_count ?? 0,
            cachedInputTokens: 0,
            estimatedCostUsd: 0,
            latencyMs: Date.now() - start,
            timeToFirstTokenMs: firstToken,
          },
        };
      }
    }
  }
}
