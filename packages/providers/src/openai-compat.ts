import type { ModelCapabilities } from "@jarvis/protocol";
import { ProviderError, type ChatMessage, type FetchLike, type GenerateRequest, type Provider, type ProviderChunk } from "./types";
import { encodeToolName, estimateCostUsd, readLines, sseData, toolNameDecoder } from "./util";

export interface OpenAICompatibleOptions {
  id: string;
  apiKey: string;
  models: ModelCapabilities[];
  baseUrl: string;
  fetch?: FetchLike;
}

/** Maps our messages onto the OpenAI wire format (tool calls carry JSON-string arguments). */
function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: encodeToolName(c.name), arguments: JSON.stringify(c.args ?? {}) } })),
    };
  }
  return { role: m.role, content: m.content };
}

interface PartialCall {
  id?: string;
  name: string;
  args: string;
}

/** OpenAI-compatible chat completions over SSE (OpenRouter, Groq, ...). */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly supportsToolCalls = true;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl;
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
    type WireUsage = { prompt_tokens?: number; completion_tokens?: number };
    let usage: WireUsage | undefined;
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages.map(toWire)];
    const calls = new Map<number, PartialCall>();
    const decodeName = toolNameDecoder((req.tools ?? []).map((t) => t.name));
    const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxTokens,
        ...(req.tools?.length
          ? { tools: req.tools.map((t) => ({ type: "function", function: { name: encodeToolName(t.name), description: t.description, parameters: t.inputSchema } })) }
          : {}),
      }),
      signal: req.signal,
    });
    for await (const line of readLines(res, this.id)) {
      const data = sseData(line);
      if (data === undefined || data === "[DONE]") continue;
      const j = JSON.parse(data) as {
        choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
        usage?: WireUsage;
        /** Groq reports the stream's usage here instead of (or as well as) in `usage`. */
        x_groq?: { usage?: WireUsage };
        error?: { message?: string };
      };
      if (j.error) throw new ProviderError(j.error.message ?? "stream error", this.id);
      for (const tc of j.choices?.[0]?.delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index ?? 0) ?? { name: "", args: "" };
        cur.id ??= tc.id;
        cur.name += tc.function?.name ?? "";
        cur.args += tc.function?.arguments ?? "";
        calls.set(tc.index ?? 0, cur);
        firstToken ??= Date.now() - start;
      }
      const text = j.choices?.[0]?.delta?.content;
      if (text) {
        firstToken ??= Date.now() - start;
        yield { type: "delta", text };
      }
      const u = j.usage ?? j.x_groq?.usage;
      if (u) usage = u;
    }
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let args: unknown;
      try {
        args = c.args ? JSON.parse(c.args) : {};
      } catch {
        args = undefined; // malformed JSON from the model; the orchestrator reports it back to the model
      }
      yield { type: "tool_call", call: { id: c.id ?? `call_${i}`, name: decodeName(c.name), args } };
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
