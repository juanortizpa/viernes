import type { ModelCapabilities } from "@jarvis/protocol";
import type { GenerateRequest, Provider, ProviderChunk, ToolCall } from "./types";
import { estimateCostUsd } from "./util";

export type FakeReply = string | { text?: string; toolCalls: ToolCall[] };

/** Deterministic provider for tests and offline development. Not a real model. */
export class FakeProvider implements Provider {
  readonly supportsToolCalls = true;
  constructor(
    readonly id: string,
    private readonly caps: ModelCapabilities[],
    private readonly respond: (req: GenerateRequest) => FakeReply = () => "ok",
  ) {}

  capabilities(): ModelCapabilities[] {
    return this.caps;
  }

  async *generate(req: GenerateRequest): AsyncGenerator<ProviderChunk> {
    const c = this.caps.find((m) => m.model === req.model);
    if (!c) throw new Error(`unknown model ${req.model}`);
    const reply = this.respond(req);
    const text = typeof reply === "string" ? reply : (reply.text ?? "");
    for (const word of text.split(/(?<= )/).filter(Boolean)) yield { type: "delta", text: word };
    if (typeof reply !== "string") for (const call of reply.toolCalls) yield { type: "tool_call", call };
    const inputTokens = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    const outputTokens = Math.ceil(text.length / 4);
    yield {
      type: "done",
      usage: { inputTokens, outputTokens, cachedInputTokens: 0, estimatedCostUsd: estimateCostUsd(c, inputTokens, outputTokens), latencyMs: 0 },
    };
  }
}
