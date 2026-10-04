import { PolicyEngine } from "@jarvis/policy";
import { EventBus, IntentRouter, MemoryBook, MemoryMemoryStore, MemoryTraceStore, Orchestrator, StaticRouter, type MemoryItem } from "@jarvis/core";
import type { ModelCapabilities } from "@jarvis/protocol";
import type { ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry } from "@jarvis/tools";
import { memoryFacts } from "./suites/memory-corpus";

/**
 * End-to-end ablation of long-term memory with a REAL model (ADR-0023). The same questions are answered three ways:
 *  A. no memory   B. production retrieval   C. every saved fact in every prompt.
 * Success is a deterministic check on the answer text (no LLM judge): the memory-dependent answers must contain the fact, the
 * general-knowledge ones must be right and must NOT mention anything from the user's memory (a "leak" of irrelevant memory).
 */
export interface AblationCase {
  q: string;
  kind: "memory" | "general" | "semantic-gap";
  /** Every pattern must match the answer. */
  expect?: RegExp[];
}

export const ablationCases: AblationCase[] = [
  { q: "¿Cómo se llama mi gato?", kind: "memory", expect: [/Pelusa/i] },
  { q: "¿Cuál es mi comida favorita?", kind: "memory", expect: [/bandeja paisa/i] },
  { q: "¿En qué ciudad vivo?", kind: "memory", expect: [/Bogot/i] },
  { q: "¿Cómo se llama mi pareja y a qué se dedica?", kind: "memory", expect: [/Laura/i, /veterinari/i] },
  { q: "¿Qué día es mi cumpleaños?", kind: "memory", expect: [/3 de mayo|mayo/i] },
  { q: "¿Soy alérgico a algo?", kind: "memory", expect: [/mariscos/i] },
  { q: "¿Qué modelo de carro tengo?", kind: "memory", expect: [/Mazda/i] },
  { q: "¿Cómo se llama mi jefe?", kind: "memory", expect: [/Carlos/i] },
  { q: "Quiero escribirle a mi hermana: ¿cómo se llama y qué le gusta tomar?", kind: "memory", expect: [/Ana/, /té/i] },
  { q: "What is my brother's name and where does he live?", kind: "memory", expect: [/Daniel/, /Toronto/] },
  // Expectations name what ONLY the memory knows, so a generic answer cannot pass by luck ("6 a.m." or "sin azúcar" are common advice).
  { q: "¿A qué hora voy al gimnasio?", kind: "memory", expect: [/6/, /martes|jueves/i] },
  { q: "¿Cómo tomo el café?", kind: "memory", expect: [/avena/i] },
  // The memory is in English ("I'm training for a half marathon"), the question in Spanish: a cross-language gap for word matching.
  { q: "¿Para qué estoy entrenando?", kind: "semantic-gap", expect: [/marat/i] },
  { q: "¿Cuántos años tiene mi hija y a qué colegio va?", kind: "memory", expect: [/6|seis/i, /San Jos[eé]/i] },
  { q: "¿Con qué empresa tengo mi plan de datos?", kind: "memory", expect: [/Claro/] },
  // The memory shares no word with the question: retrieval is expected to miss these (stuffing everything may not).
  { q: "¿Qué lenguajes de programación uso?", kind: "semantic-gap", expect: [/Python/i, /TypeScript/i] },
  { q: "¿Puedo pedir ceviche esta noche? Responde sí o no y por qué.", kind: "semantic-gap", expect: [/al[eé]rgic/i] },
  // General knowledge: nothing about the user is needed.
  { q: "¿Cuál es la capital de Francia?", kind: "general", expect: [/Par[ií]s/i] },
  { q: "Explica qué es un closure en JavaScript en dos frases.", kind: "general", expect: [/funci/i] },
  { q: "¿Cuánto es 17 por 23?", kind: "general", expect: [/391/] },
  { q: "Dame una receta corta de arepas.", kind: "general" },
  { q: "Write a haiku about the sea.", kind: "general" },
];

/** Things only the user's memory knows: a general answer must not contain them. */
const LEAK = /Pelusa|\bAna\b|Bogot[aá]|Laura|Mazda|Carlos|Daniel|Toronto|Lisboa|Sof[ií]a|bandeja paisa|mariscos|penicilina|Medell[ií]n|Trek|Atl[eé]tico/i;

export type Arm = "A" | "B" | "C";
export const armNames: Record<Arm, string> = { A: "A · sin memoria", B: "B · recuperación (producción)", C: "C · toda la memoria en cada consulta" };

export interface AblationSample {
  arm: Arm;
  q: string;
  kind: AblationCase["kind"];
  ok: boolean;
  leaked: boolean;
  inputTokens: number;
  error?: string;
  answer: string;
}

function makeMemory(arm: Arm): Pick<MemoryBook, "retrieve" | "markUsed"> | undefined {
  if (arm === "A") return undefined;
  const book = new MemoryBook({ store: new MemoryMemoryStore(), maxItems: 1_000 });
  for (const f of memoryFacts.filter((f) => !f.key.startsWith("p-"))) book.add(f.text, "fact");
  if (arm === "B") return book;
  const all = book.list();
  return { retrieve: () => ({ preferences: [], facts: all.map((item: MemoryItem) => ({ item, score: 1 })) }), markUsed: () => {} };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runAblationSample(arm: Arm, c: AblationCase, model: ModelCapabilities, providers: ProviderRegistry): Promise<AblationSample> {
  const bus = new EventBus();
  let answer = "";
  bus.subscribe((e) => {
    if (e.type === "response.delta") answer += e.text;
    if (e.type === "task.started") answer = "";
  });
  const memory = makeMemory(arm);
  const orch = new Orchestrator({
    bus,
    intents: new IntentRouter({ apps: {} }),
    router: new StaticRouter(model.model),
    providers,
    tools: new ToolRegistry(),
    policy: new PolicyEngine(),
    askPermission: async () => false,
    traces: new MemoryTraceStore(),
    ...(memory ? { memory } : {}),
  });
  let error: string | undefined;
  let inputTokens = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    answer = "";
    const trace = await orch.run(c.q);
    inputTokens = trace.attempts.at(-1)?.usage.inputTokens ?? 0;
    if (trace.finalOutcome === "success") {
      error = undefined;
      break;
    }
    error = "failed";
    await sleep(8_000 * (attempt + 1)); // free tiers rate-limit by minute: wait it out rather than count it as a wrong answer
  }
  // Models emit non-breaking spaces and decomposed accents ("San José" failed a plain-space pattern): compare normalised text.
  const text = answer.normalize("NFC").replace(/\s+/g, " ").trim();
  const ok = !error && (c.expect ?? []).every((re) => re.test(text));
  return { arm, q: c.q, kind: c.kind, ok, leaked: !error && c.kind === "general" && LEAK.test(text), inputTokens, ...(error ? { error } : {}), answer: text };
}

export interface AblationSummary {
  arm: Arm;
  memoryOk: string;
  gapOk: string;
  generalOk: string;
  leaks: string;
  meanInputTokens: number;
  errors: number;
}

const frac = (xs: boolean[]): string => `${xs.filter(Boolean).length}/${xs.length}`;

export function summarize(samples: AblationSample[]): AblationSummary[] {
  return (["A", "B", "C"] as Arm[]).map((arm) => {
    const s = samples.filter((x) => x.arm === arm && !x.error);
    const of = (kind: AblationCase["kind"]) => s.filter((x) => x.kind === kind);
    return {
      arm,
      memoryOk: frac(of("memory").map((x) => x.ok)),
      gapOk: frac(of("semantic-gap").map((x) => x.ok)),
      generalOk: frac(of("general").filter((x) => ablationCases.find((c) => c.q === x.q)?.expect).map((x) => x.ok)),
      leaks: frac(of("general").map((x) => x.leaked)),
      meanInputTokens: s.length ? Math.round(s.reduce((n, x) => n + x.inputTokens, 0) / s.length) : 0,
      errors: samples.filter((x) => x.arm === arm && x.error).length,
    };
  });
}

export function renderAblation(model: string, samples: AblationSample[]): string {
  const rows = summarize(samples).map((r) => `| ${armNames[r.arm]} | ${r.memoryOk} | ${r.gapOk} | ${r.generalOk} | ${r.leaks} | ${r.meanInputTokens} | ${r.errors} |`);
  return [
    `\n**${model}**\n`,
    "| Brazo | Responde con un dato guardado | Hueco semántico | Conocimiento general correcto | Fugas de memoria irrelevante | Tokens de entrada (media) | Errores |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
