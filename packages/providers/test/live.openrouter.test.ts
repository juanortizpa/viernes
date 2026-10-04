import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@jarvis/protocol";
import { OpenRouterProvider } from "../src/openrouter";

const key = process.env.JARVIS_LIVE ? process.env.OPENROUTER_API_KEY : undefined;

// Prices in USD per 1M tokens, as listed by OpenRouter for openai/gpt-4o-mini.
const model: ModelCapabilities = {
  model: "openai/gpt-4o-mini",
  provider: "openrouter",
  supportsVision: false,
  supportsTools: true,
  supportsStreaming: true,
  contextWindow: 128000,
  estimatedInputCost: 0.15,
  estimatedOutputCost: 0.6,
  expectedLatency: 800,
  isLocal: false,
};

/** Live smoke test (real network, costs fractions of a cent). Run with JARVIS_LIVE=1 and OPENROUTER_API_KEY set. */
describe.skipIf(!key)("OpenRouter live", () => {
  it("streams a reply and the computed cost matches what OpenRouter reports", async () => {
    let reportedCost: number | undefined;
    const spyFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const copy = res.clone();
      void copy.text().then((t) => {
        for (const line of t.split("\n")) {
          if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
          const j = JSON.parse(line.slice(5)) as { usage?: { cost?: number } };
          if (j.usage?.cost !== undefined) reportedCost = j.usage.cost;
        }
      });
      return res;
    };
    const p = new OpenRouterProvider({ apiKey: key!, models: [model], fetch: spyFetch });
    let text = "";
    let done;
    for await (const c of p.generate({
      model: model.model,
      system: "Responde en una sola palabra.",
      messages: [{ role: "user", content: "Saluda." }],
      maxTokens: 20,
    })) {
      if (c.type === "delta") text += c.text;
      else if (c.type === "done") done = c.usage;
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(text.length).toBeGreaterThan(0);
    expect(done?.inputTokens).toBeGreaterThan(0);
    expect(done?.outputTokens).toBeGreaterThan(0);
    expect(done?.timeToFirstTokenMs).toBeGreaterThan(0);
    expect(reportedCost).toBeDefined();
    console.log({ text, usage: done, reportedCost });
    // Within 5% (or 1e-7 USD for sub-cent amounts).
    expect(Math.abs(done!.estimatedCostUsd - reportedCost!)).toBeLessThanOrEqual(Math.max(reportedCost! * 0.05, 1e-7));
  }, 30_000);
});
