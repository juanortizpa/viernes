import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@jarvis/protocol";
import {
  AnthropicProvider,
  FakeProvider,
  OllamaProvider,
  OpenRouterProvider,
  ProviderRegistry,
  type FetchLike,
  type Provider,
  type ProviderChunk,
} from "../src";

const caps = (model: string, provider: string, extra: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  model,
  provider,
  supportsVision: false,
  supportsTools: true,
  supportsStreaming: true,
  contextWindow: 100_000,
  estimatedInputCost: 1,
  estimatedOutputCost: 2,
  expectedLatency: 500,
  isLocal: false,
  ...extra,
});

const body = (lines: string[]): FetchLike => async () =>
  new Response(lines.join("\n") + "\n", { status: 200 });

async function collect(p: Provider, model: string) {
  const chunks: ProviderChunk[] = [];
  for await (const c of p.generate({ model, messages: [{ role: "user", content: "hi" }] })) chunks.push(c);
  const text = chunks.flatMap((c) => (c.type === "delta" ? [c.text] : [])).join("");
  const done = chunks.find((c) => c.type === "done");
  return { text, usage: done?.type === "done" ? done.usage : undefined };
}

describe("ProviderRegistry", () => {
  it("aggregates capabilities and rejects duplicate ids", () => {
    const r = new ProviderRegistry()
      .register(new FakeProvider("a", [caps("m1", "a")]))
      .register(new FakeProvider("b", [caps("m2", "b")]));
    expect(r.capabilities().map((c) => c.model)).toEqual(["m1", "m2"]);
    expect(() => r.register(new FakeProvider("a", []))).toThrow();
  });
});

describe("FakeProvider", () => {
  it("streams deltas and reports usage with cost from capabilities", async () => {
    const p = new FakeProvider("f", [caps("m", "f", { estimatedInputCost: 1_000_000, estimatedOutputCost: 1_000_000 })], () => "hola mundo");
    const { text, usage } = await collect(p, "m");
    expect(text).toBe("hola mundo");
    expect(usage?.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe("OllamaProvider", () => {
  it("parses NDJSON, usage and zero cost", async () => {
    const p = new OllamaProvider({
      models: [caps("llama", "ollama", { isLocal: true })],
      fetch: body([
        JSON.stringify({ message: { content: "ho" }, done: false }),
        JSON.stringify({ message: { content: "la" }, done: false }),
        JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 2 }),
      ]),
    });
    const { text, usage } = await collect(p, "llama");
    expect(text).toBe("hola");
    expect(usage).toMatchObject({ inputTokens: 5, outputTokens: 2, estimatedCostUsd: 0 });
  });

  it("surfaces HTTP errors", async () => {
    const p = new OllamaProvider({ models: [], fetch: async () => new Response("boom", { status: 500 }) });
    await expect(collect(p, "x")).rejects.toThrow(/HTTP 500/);
  });
});

describe("OpenRouterProvider", () => {
  it("parses SSE deltas, ignores [DONE], prices usage", async () => {
    let auth = "";
    const p = new OpenRouterProvider({
      apiKey: "k",
      models: [caps("or/m", "openrouter", { estimatedInputCost: 1_000_000, estimatedOutputCost: 2_000_000 })],
      fetch: async (_u, init) => {
        auth = (init.headers as Record<string, string>).authorization ?? "";
        return body([
          'data: {"choices":[{"delta":{"content":"ho"}}]}',
          "",
          'data: {"choices":[{"delta":{"content":"la"}}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          "data: [DONE]",
        ])(_u, init);
      },
    });
    const { text, usage } = await collect(p, "or/m");
    expect(auth).toBe("Bearer k");
    expect(text).toBe("hola");
    expect(usage).toMatchObject({ inputTokens: 3, outputTokens: 1, estimatedCostUsd: 5 });
  });
});

describe("AnthropicProvider", () => {
  it("parses message events and usage", async () => {
    const p = new AnthropicProvider({
      apiKey: "k",
      models: [caps("claude-x", "anthropic", { estimatedInputCost: 1_000_000, estimatedOutputCost: 1_000_000 })],
      fetch: body([
        "event: message_start",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4}}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ho"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"la"}}',
        'data: {"type":"message_delta","usage":{"output_tokens":6}}',
        'data: {"type":"message_stop"}',
      ]),
    });
    const { text, usage } = await collect(p, "claude-x");
    expect(text).toBe("hola");
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 6, cachedInputTokens: 4, estimatedCostUsd: 16 });
  });

  it("throws on stream error events", async () => {
    const p = new AnthropicProvider({
      apiKey: "k",
      models: [caps("claude-x", "anthropic")],
      fetch: body(['data: {"type":"error","error":{"message":"overloaded"}}']),
    });
    await expect(collect(p, "claude-x")).rejects.toThrow(/overloaded/);
  });
});
