import type { ModelCapabilities, Usage } from "@jarvis/protocol";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ProviderChunk = { type: "delta"; text: string } | { type: "done"; usage: Usage };

/** Common adapter interface (ADR-0003). The router only sees `capabilities()`. */
export interface Provider {
  readonly id: string;
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
