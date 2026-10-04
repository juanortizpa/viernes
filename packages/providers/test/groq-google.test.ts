import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@jarvis/protocol";
import { GoogleProvider, GroqProvider, ProviderError, type ChatMessage, type FetchLike, type Provider, type ProviderChunk, type ToolSpec } from "../src";

const caps = (model: string, provider: string, over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  model, provider, supportsVision: false, supportsTools: true, supportsStreaming: true, contextWindow: 100_000,
  estimatedInputCost: 1_000_000, estimatedOutputCost: 2_000_000, expectedLatency: 500, isLocal: false, ...over,
});

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n`).join("\n") + "\n";

async function run(p: Provider, req: { model: string; messages?: ChatMessage[]; tools?: ToolSpec[]; system?: string; maxTokens?: number }) {
  const chunks: ProviderChunk[] = [];
  for await (const c of p.generate({ messages: [{ role: "user", content: "hi" }], ...req })) chunks.push(c);
  return {
    chunks,
    text: chunks.flatMap((c) => (c.type === "delta" ? [c.text] : [])).join(""),
    calls: chunks.flatMap((c) => (c.type === "tool_call" ? [c.call] : [])),
    usage: chunks.find((c) => c.type === "done")!.type === "done" ? (chunks.find((c) => c.type === "done") as Extract<ProviderChunk, { type: "done" }>).usage : undefined,
  };
}

describe("GroqProvider", () => {
  it("talks to Groq's OpenAI-compatible endpoint, encodes dotted tool names and reads usage from x_groq", async () => {
    let url = "", auth = "", sent: any;
    const fetch: FetchLike = async (u, init) => {
      url = u; auth = (init.headers as Record<string, string>).authorization!; sent = JSON.parse(init.body as string);
      return new Response(
        sse(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "files__read", arguments: '{"path":"a"}' } }] } }] },
          { choices: [{ delta: { content: "ok" } }] },
          { choices: [], x_groq: { usage: { prompt_tokens: 4, completion_tokens: 2 } } },
        ) + "data: [DONE]\n",
        { status: 200 },
      );
    };
    const p = new GroqProvider({ apiKey: "gk", models: [caps("llama", "groq")], fetch });
    const r = await run(p, { model: "llama", tools: [{ name: "files.read", description: "d", inputSchema: { type: "object" } }] });
    expect(p.id).toBe("groq");
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(auth).toBe("Bearer gk");
    expect(sent.tools[0].function.name).toBe("files__read");
    expect(r.calls).toEqual([{ id: "c1", name: "files.read", args: { path: "a" } }]);
    expect(r.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, estimatedCostUsd: 8 });
  });
});

describe("GoogleProvider", () => {
  const make = (fetch: FetchLike, over: Partial<ModelCapabilities> = {}) => new GoogleProvider({ apiKey: "ak", models: [caps("gemini-x", "google", over)], fetch });

  it("streams text, skips thought summaries, bills thinking tokens as output, and sends key/system/limits", async () => {
    let url = "", key = "", sent: any;
    const p = make(async (u, init) => {
      url = u; key = (init.headers as Record<string, string>)["x-goog-api-key"]!; sent = JSON.parse(init.body as string);
      return new Response(
        sse(
          { candidates: [{ content: { parts: [{ text: "pensando", thought: true }, { text: "ho" }] } }] },
          { candidates: [{ content: { parts: [{ text: "la" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, thoughtsTokenCount: 4 } },
        ),
        { status: 200 },
      );
    });
    const r = await run(p, { model: "gemini-x", system: "sé breve", maxTokens: 50 });
    expect(r.text).toBe("hola");
    expect(r.usage).toMatchObject({ inputTokens: 3, outputTokens: 5, estimatedCostUsd: 13 });
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse");
    expect(key).toBe("ak");
    expect(sent.systemInstruction).toEqual({ parts: [{ text: "sé breve" }] });
    expect(sent.generationConfig).toEqual({ maxOutputTokens: 50 });
    expect(sent.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("converts tool schemas to Gemini's subset and omits parameters for tools without arguments", async () => {
    let sent: any;
    const p = make(async (_u, init) => ((sent = JSON.parse(init.body as string)), new Response(sse({ candidates: [] }), { status: 200 })));
    await run(p, {
      model: "gemini-x",
      tools: [
        { name: "time.now", description: "now", inputSchema: { type: "object", properties: {}, additionalProperties: false, $schema: "x" } },
        {
          name: "files.write", description: "w",
          inputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false, required: ["path"],
            properties: { path: { type: "string", minLength: 1 }, mode: { type: ["string", "null"], default: "a" }, n: { type: "integer", minimum: 0 } },
          },
        },
      ],
    });
    const [now, write] = sent.tools[0].functionDeclarations;
    expect(now).toEqual({ name: "time.now", description: "now" });
    expect(write.parameters).toEqual({
      type: "object", required: ["path"],
      properties: { path: { type: "string" }, mode: { type: "string", nullable: true }, n: { type: "integer", minimum: 0 } },
    });
  });

  it("round-trips tool calls: functionCall with thought signature, then one user turn of functionResponses named after the calls", async () => {
    const bodies: any[] = [];
    let n = 0;
    const p = make(async (_u, init) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(
        n++ === 0
          ? sse({ candidates: [{ content: { parts: [{ functionCall: { name: "time.now", args: {} }, thoughtSignature: "SIG" }, { functionCall: { name: "files.read", args: { path: "a" } } }] } }] })
          : sse({ candidates: [{ content: { parts: [{ text: "listo" }] } }] }),
        { status: 200 },
      );
    });
    const first = await run(p, { model: "gemini-x" });
    expect(first.calls).toEqual([
      { id: "call_0", name: "time.now", args: {}, providerData: { thoughtSignature: "SIG" } },
      { id: "call_1", name: "files.read", args: { path: "a" } },
    ]);
    const second = await run(p, {
      model: "gemini-x",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: first.calls },
        { role: "tool", toolCallId: "call_0", content: '{"ok":true}' },
        { role: "tool", toolCallId: "call_1", content: '{"ok":false}' },
      ],
    });
    expect(second.text).toBe("listo");
    expect(bodies[1].contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ functionCall: { name: "time.now", args: {} }, thoughtSignature: "SIG" }, { functionCall: { name: "files.read", args: { path: "a" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "time.now", response: { result: '{"ok":true}' } } }, { functionResponse: { name: "files.read", response: { result: '{"ok":false}' } } }] },
    ]);
  });

  it("surfaces HTTP errors with status (so quota detection and cascade see them) and blocked prompts", async () => {
    const quota = make(async () => new Response('{"error":{"message":"Quota exceeded ... GenerateRequestsPerDayPerProjectPerModel-FreeTier","status":"RESOURCE_EXHAUSTED"}}', { status: 429 }));
    await expect(run(quota, { model: "gemini-x" })).rejects.toMatchObject({ status: 429, message: expect.stringContaining("PerDay") });
    const blocked = make(async () => new Response(sse({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 }));
    await expect(run(blocked, { model: "gemini-x" })).rejects.toThrow(ProviderError);
    await expect(run(blocked, { model: "gemini-x" })).rejects.toThrow(/SAFETY/);
  });
});
