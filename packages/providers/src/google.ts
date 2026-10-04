import type { ModelCapabilities } from "@jarvis/protocol";
import { ProviderError, type ChatMessage, type FetchLike, type GenerateRequest, type Provider, type ProviderChunk, type ToolSpec } from "./types";
import { estimateCostUsd, readLines, sseData } from "./util";

export interface GoogleOptions {
  apiKey: string;
  models: ModelCapabilities[];
  baseUrl?: string;
  fetch?: FetchLike;
}

type Part = Record<string, unknown>;
interface Content {
  role: "user" | "model";
  parts: Part[];
}

/** Only these JSON Schema keywords exist in Gemini's schema subset; anything else (e.g. `additionalProperties`, `$schema`) is a 400. */
const SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "items", "properties", "required", "minimum", "maximum", "minItems", "maxItems", "anyOf"]);

function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, sanitizeSchema(s)]));
    } else if (k === "type" && Array.isArray(v)) {
      const real = v.filter((t) => t !== "null");
      out.type = real[0] ?? "string";
      if (real.length < v.length) out.nullable = true;
    } else if (SCHEMA_KEYS.has(k)) out[k] = sanitizeSchema(v);
  }
  return out;
}

function toolDeclaration(t: ToolSpec): Record<string, unknown> {
  const params = sanitizeSchema(t.inputSchema) as { properties?: Record<string, unknown> };
  // An OBJECT schema with no properties is rejected, so tools without arguments omit `parameters`.
  const hasArgs = params.properties && Object.keys(params.properties).length > 0;
  return { name: t.name, description: t.description, ...(hasArgs ? { parameters: params } : {}) };
}

/** Our messages -> Gemini contents. Tool results are `functionResponse` parts, all of one round in a single user turn. */
function toContents(messages: ChatMessage[]): Content[] {
  const names = new Map<string, string>();
  const out: Content[] = [];
  let pending: Part[] = [];
  const flush = (): void => {
    if (pending.length) out.push({ role: "user", parts: pending });
    pending = [];
  };
  for (const m of messages) {
    if (m.role === "tool") {
      pending.push({ functionResponse: { name: names.get(m.toolCallId) ?? "unknown", response: { result: m.content } } });
      continue;
    }
    flush();
    if (m.role === "user") out.push({ role: "user", parts: [{ text: m.content }] });
    else {
      const parts: Part[] = m.content ? [{ text: m.content }] : [];
      for (const c of m.toolCalls ?? []) {
        names.set(c.id, c.name);
        const sig = (c.providerData as { thoughtSignature?: string } | undefined)?.thoughtSignature;
        parts.push({ functionCall: { name: c.name, args: c.args ?? {} }, ...(sig ? { thoughtSignature: sig } : {}) });
      }
      if (parts.length) out.push({ role: "model", parts });
    }
  }
  flush();
  return out;
}

interface WireChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { id?: string; name: string; args?: unknown } }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number };
}

/** Google AI Studio (Gemini API), streaming `generateContent`. */
export class GoogleProvider implements Provider {
  readonly id = "google";
  readonly supportsToolCalls = true;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  constructor(private readonly opts: GoogleOptions) {
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
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
    let usage: WireChunk["usageMetadata"];
    let calls = 0;

    const res = await this.fetch(`${this.baseUrl}/models/${req.model.replace(/^models\//, "")}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
      body: JSON.stringify({
        ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
        contents: toContents(req.messages),
        ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map(toolDeclaration) }] } : {}),
        ...(req.maxTokens ? { generationConfig: { maxOutputTokens: req.maxTokens } } : {}),
      }),
      signal: req.signal,
    });

    for await (const line of readLines(res, this.id)) {
      const data = sseData(line);
      if (data === undefined) continue;
      const j = JSON.parse(data) as WireChunk;
      if (j.error) throw new ProviderError(j.error.message ?? "stream error", this.id, j.error.code);
      if (j.promptFeedback?.blockReason && !j.candidates?.length) throw new ProviderError(`prompt blocked: ${j.promptFeedback.blockReason}`, this.id);
      for (const part of j.candidates?.[0]?.content?.parts ?? []) {
        if (part.functionCall) {
          firstToken ??= Date.now() - start;
          yield {
            type: "tool_call",
            call: {
              id: part.functionCall.id ?? `call_${calls++}`,
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
              ...(part.thoughtSignature ? { providerData: { thoughtSignature: part.thoughtSignature } } : {}),
            },
          };
        } else if (part.text && !part.thought) {
          firstToken ??= Date.now() - start;
          yield { type: "delta", text: part.text };
        }
      }
      if (j.usageMetadata) usage = j.usageMetadata;
    }

    const inputTokens = usage?.promptTokenCount ?? 0;
    // Thinking tokens are billed as output.
    const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
    yield {
      type: "done",
      usage: { inputTokens, outputTokens, cachedInputTokens: 0, estimatedCostUsd: estimateCostUsd(caps, inputTokens, outputTokens), latencyMs: Date.now() - start, timeToFirstTokenMs: firstToken },
    };
  }
}
