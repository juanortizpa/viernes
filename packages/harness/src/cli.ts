import { readFileSync, writeFileSync } from "node:fs";
import { ModelCapabilities } from "@jarvis/protocol";
import { RulesRouter } from "@jarvis/core";
import { AnthropicProvider, OllamaProvider, OpenRouterProvider, ProviderRegistry } from "@jarvis/providers";
import { z } from "zod";
import {
  CellTable, alwaysCheapest, alwaysPremium, analyze, buildReplayData, cascadePolicy, crossValidatedPolicy, heuristicJudge, oracleJudge, oraclePolicy,
  renderMarkdown, routerPolicy, runCounterfactual, seedSuite, type Policy, type PriceBook,
} from "./index";
import { AlwaysCheapestRouter } from "@jarvis/core";

const Models = z.array(ModelCapabilities).default([]);
const Config = z.object({
  ollama: z.object({ baseUrl: z.string().url().optional(), models: Models }).optional(),
  anthropic: z.object({ models: Models }).optional(),
  openrouter: z.object({ models: Models }).optional(),
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
  const key = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const providers = new ProviderRegistry();
  const models: ModelCapabilities[] = [];
  if (cfg.ollama) (providers.register(new OllamaProvider({ baseUrl: cfg.ollama.baseUrl, models: filter(cfg.ollama.models) })), models.push(...filter(cfg.ollama.models)));
  if (cfg.anthropic) (providers.register(new AnthropicProvider({ apiKey: key("ANTHROPIC_API_KEY"), models: filter(cfg.anthropic.models) })), models.push(...filter(cfg.anthropic.models)));
  if (cfg.openrouter) (providers.register(new OpenRouterProvider({ apiKey: key("OPENROUTER_API_KEY"), models: filter(cfg.openrouter.models) })), models.push(...filter(cfg.openrouter.models)));
  if (models.length < 2) throw new Error("need at least two models to compare");
  if (!flags.has("allow-paid") && models.some((m) => m.estimatedInputCost > 0 || m.estimatedOutputCost > 0)) {
    throw new Error("a configured model has a non-zero price; this project is free-only for now. Pass --allow-paid to override.");
  }
  return { models, providers };
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
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

  console.log("usage:\n  harness run    --config <json> [--table path] [--models a,b] [--limit N] [--concurrency N] [--budget N] [--max-tokens N]\n  harness report --config <json> [--table path] [--prices json] [--out file.md] [--seed N]");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
