import type { ModelCapabilities } from "@jarvis/protocol";
import { ProviderError } from "./types";

export const estimateCostUsd = (c: ModelCapabilities, inputTokens: number, outputTokens: number): number =>
  (inputTokens * c.estimatedInputCost + outputTokens * c.estimatedOutputCost) / 1_000_000;

/** Yields non-empty lines of a streamed HTTP body (works for SSE and NDJSON). */
export async function* readLines(res: Response, provider: string): AsyncGenerator<string> {
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${await res.text().catch(() => "")}`, provider, res.status);
  if (!res.body) throw new ProviderError("empty response body", provider);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

/** Payload of an SSE `data:` line, or undefined for other lines. */
export const sseData = (line: string): string | undefined => (line.startsWith("data:") ? line.slice(5).trim() : undefined);
