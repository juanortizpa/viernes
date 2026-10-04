import type { ModelCapabilities, Usage } from "@jarvis/protocol";

/** A tool the model may call. `inputSchema` is JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** `args` is whatever the model produced; `undefined` if it was not valid JSON. The caller validates it. */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface GenerateRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Only honoured by providers with `supportsToolCalls`. */
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export type ProviderChunk =
  | { type: "delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; usage: Usage };

/** Common adapter interface (ADR-0003). The router only sees `capabilities()`. */
export interface Provider {
  readonly id: string;
  /** Adapter implements tool calling. Capabilities say what a model can do; this says what the adapter can do. */
  readonly supportsToolCalls?: boolean;
  capabilities(): ModelCapabilities[];
  generate(req: GenerateRequest): AsyncGenerator<ProviderChunk>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
