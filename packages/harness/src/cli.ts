import { readFileSync, writeFileSync } from "node:fs";
import { ModelCapabilities } from "@jarvis/protocol";
import { RulesRouter } from "@jarvis/core";
import { AnthropicProvider, GoogleProvider, GroqProvider, OllamaProvider, OpenRouterProvider, ProviderRegistry } from "@jarvis/providers";
import { z } from "zod";
import {
  CellTable, alwaysCheapest, alwaysPremium, analyze, buildReplayData, cascadePolicy, crossValidatedPolicy, heuristicJudge, oracleJudge, oraclePolicy,
  evalInstantCache, renderInstantEval, renderMarkdown, routerPolicy, runCounterfactual, seedSuite, type Policy, type PriceBook,
} from "./index";
import { AlwaysCheapestRouter } from "@jarvis/core";

const Models = z.array(ModelCapabilities).default([]);
const Config = z.object({
  ollama: z.object({ baseUrl: z.string().url().optional(), models: Models }).optional(),
  anthropic: z.object({ models: Models }).optional(),
  openrouter: z.object({ models: Models }).optional(),
  groq: z.object({ models: Models }).optional(),
  google: z.object({ models: Models }).optional(),
});

function parseArgs(argv: string[]): { cmd: string; flags: Map<string, string> } {
  const [cmd = "", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(a.slice(2), "true");
    else (flags.set(a.slice(2), next), i++);
  }
  return { cmd, flags };
}

function load(flags: Map<string, string>): { models: ModelCapabilities[]; providers: ProviderRegistry } {
  const configPath = flags.get("config");
  if (!configPath) throw new Error("--config <jarvis config json> is required");
  const cfg = Config.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const only = flags.get("models")?.split(",");
  const filter = (ms: ModelCapabilities[]) => (only ? ms.filter((m) => only.includes(m.model)) : ms);
  const key = (...names: string[]) => {
    const v = names.map((n) => process.env[n]).find(Boolean);
    if (!v) throw new Error(`${names.join(" or ")} is not set`);
    return v;
  };
  const providers = new ProviderRegistry();
  const models: ModelCapabilities[] = [];
  if (cfg.ollama) (providers.register(new OllamaProvider({ baseUrl: cfg.ollama.baseUrl, models: filter(cfg.ollama.models) })), models.push(...filter(cfg.ollama.models)));
  if (cfg.anthropic) (providers.register(new AnthropicProvider({ apiKey: key("ANTHROPIC_API_KEY"), models: filter(cfg.anthropic.models) })), models.push(...filter(cfg.anthropic.models)));
  if (cfg.openrouter) (providers.register(new OpenRouterProvider({ apiKey: key("OPENROUTER_API_KEY"), models: filter(cfg.openrouter.models) })), models.push(...filter(cfg.openrouter.models)));
  if (cfg.groq) (providers.register(new GroqProvider({ apiKey: key("GROQ_API_KEY"), models: filter(cfg.groq.models) })), models.push(...filter(cfg.groq.models)));
  if (cfg.google) (providers.register(new GoogleProvider({ apiKey: key("GEMINI_API_KEY", "GOOGLE_API_KEY"), models: filter(cfg.google.models) })), models.push(...filter(cfg.google.models)));
  if (models.length < 2) throw new Error("need at least two models to compare");
  if (!flags.has("allow-paid") && models.some((m) => m.estimatedInputCost > 0 || m.estimatedOutputCost > 0)) {
    throw new Error("a configured model has a non-zero price; this project is free-only for now. Pass --allow-paid to override.");
  }
  return { models, providers };
}

/** Model ids a key can actually use, so configs are written from facts rather than memory. */
async function listModels(provider: string): Promise<void> {
  if (provider === "groq") {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("GROQ_API_KEY is not set");
    const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const { data } = (await res.json()) as { data: { id: string; context_window?: number; active?: boolean }[] };
    for (const m of data.filter((m) => m.active !== false)) console.log(`${m.id}\tcontext=${m.context_window ?? "?"}`);
  } else if (provider === "google") {
    const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is not set");
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const { models } = (await res.json()) as { models: { name: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }[] };
    // Only models that support streamGenerateContent can be used by the adapter (Live/audio-only models cannot).
    for (const m of models.filter((m) => m.supportedGenerationMethods?.includes("generateContent"))) console.log(`${m.name.replace(/^models\//, "")}\tcontext=${m.inputTokenLimit ?? "?"}`);
  } else throw new Error("--provider must be groq or google");
  console.log("Free-tier limits are per account: check them in the provider's dashboard before putting a model in a config.");
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd === "instant-eval") return console.log(renderInstantEval(evalInstantCache([0.5, 0.6, 0.7, 0.8, 0.9])));
  if (cmd === "list-models") return listModels(flags.get("provider") ?? "");
  const tablePath = flags.get("table") ?? "data/counterfactual.jsonl";
  const tasks = seedSuite.slice(0, flags.has("limit") ? Number(flags.get("limit")) : undefined);

  if (cmd === "run") {
    const { models, providers } = load(flags);
    const table = new CellTable(tablePath);
    console.log(`${tasks.length} tasks x ${models.length} models -> ${tablePath}`);
    const res = await runCounterfactual({
      tasks, models, providers, table,
      concurrency: Number(flags.get("concurrency") ?? 2),
      budget: flags.has("budget") ? Number(flags.get("budget")) : undefined,
      maxTokens: flags.has("max-tokens") ? Number(flags.get("max-tokens")) : undefined,
      onCell: (c, done, total) => console.log(`[${done}/${total}] ${c.model} ${c.taskId} ${c.error ? `ERROR ${c.error.slice(0, 80)}` : c.pass ? "pass" : `fail (${c.detail})`}`),
    });
    console.log(res);
    if (res.stopped === "quota") console.log("Daily quota exhausted; the table is saved. Re-run later to resume (OpenRouter free tier: 50 requests/day, resets 00:00 UTC).");
    if (res.stopped === "budget") console.log("Budget reached; re-run to continue.");
    return;
  }

  if (cmd === "report") {
    const { models } = load(new Map([...flags, ["config", flags.get("config") ?? ""]]));
    const prices: PriceBook = flags.has("prices") ? JSON.parse(readFileSync(flags.get("prices")!, "utf8")) : {};
    const { data, dropped } = buildReplayData(tasks, models, new CellTable(tablePath), prices);
    if (data.tasks.length === 0) throw new Error("no task has results for every model; run `run` first");
    const policies: Policy[] = [
      alwaysPremium(),
      alwaysCheapest(),
      routerPolicy("C_rules", new RulesRouter()),
      oraclePolicy(),
      cascadePolicy("cascade_heuristic", new AlwaysCheapestRouter(), heuristicJudge(), 2),
      cascadePolicy("cascade_ground_truth", new AlwaysCheapestRouter(), oracleJudge, 2),
      crossValidatedPolicy("learned_cv_simplified", data.tasks, data),
    ];
    const md = renderMarkdown(analyze(policies, data, "A_always_premium", dropped, Number(flags.get("seed") ?? 1)), data.prices);
    if (flags.has("out")) writeFileSync(flags.get("out")!, md);
    console.log(md);
    return;
  }

  console.log("usage:\n  harness instant-eval\n  harness list-models --provider groq|google\n  harness run    --config <json> [--table path] [--models a,b] [--limit N] [--concurrency N] [--budget N] [--max-tokens N]\n  harness report --config <json> [--table path] [--prices json] [--out file.md] [--seed N]");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
