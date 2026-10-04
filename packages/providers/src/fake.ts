import type { ModelCapabilities } from "@jarvis/protocol";
import type { GenerateRequest, Provider, ProviderChunk } from "./types";
import { estimateCostUsd } from "./util";

/** Deterministic provider for tests and offline development. Not a real model. */
export class FakeProvider implements Provider {
  constructor(
    readonly id: string,
    private readonly caps: ModelCapabilities[],
    private readonly respond: (req: GenerateRequest) => string = () => "ok",
  ) {}

  capabilities(): ModelCapabilities[] {
    return this.caps;
  }

  async *generate(req: GenerateRequest): AsyncGenerator<ProviderChunk> {
    const c = this.caps.find((m) => m.model === req.model);
    if (!c) throw new Error(`unknown model ${req.model}`);
    const text = this.respond(req);
    for (const word of text.split(/(?<= )/)) yield { type: "delta", text: word };
    const inputTokens = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    const outputTokens = Math.ceil(text.length / 4);
    yield {
      type: "done",
      usage: { inputTokens, outputTokens, cachedInputTokens: 0, estimatedCostUsd: estimateCostUsd(c, inputTokens, outputTokens), latencyMs: 0 },
    };
  }
}
