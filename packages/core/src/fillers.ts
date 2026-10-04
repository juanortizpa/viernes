import type { TaskClass } from "./task-classifier";

/**
 * Spoken fillers (ADR-0029): what a person says so the other one knows they were heard, while the real answer is on its way.
 * Rules that keep them honest and useful:
 * - Only for spoken conversations, and only when the answer is predicted to take long enough to leave an awkward silence (the
 *   prediction comes from the learned per-model latency, ModelHealth).
 * - They never claim a result or progress that did not happen: a receipt ("A ver…") or a description of what is ABOUT to run,
 *   emitted when it really starts ("Lo busco." on the actual web.search call).
 * - Short: they are queued before the answer, so a long filler would delay it. Receipts are one or two words.
 * - Varied, without repeating the last one, so they do not sound like a machine.
 */
export interface FillerContext {
  input: string;
  cls: TaskClass;
  /** Predicted ms until the first sentence of the answer exists. */
  predictedMs: number;
}

const RECEIPTS = ["A ver…", "Mmm, a ver.", "Dale.", "Ya te digo.", "Un segundo.", "Dejame ver."];
const QUESTION_RECEIPTS = ["Buena pregunta.", "A ver…", "Mmm…", "Dejame pensar."];
const LONG_RECEIPTS = ["Dale, me pongo con eso.", "Ok, lo armo.", "Dale, dame un momento."];

export class FillerPolicy {
  private n = 0;
  private last: string | undefined;

  /** ms of predicted silence after which a receipt is worth saying (TTS needs ~150 ms to start, so ~0.6 s feels instant). */
  constructor(private readonly o: { thresholdMs?: number } = {}) {}

  private pick(list: readonly string[]): string {
    let s = list[this.n++ % list.length]!;
    if (s === this.last) s = list[this.n++ % list.length]!;
    this.last = s;
    return s;
  }

  /** A receipt when the user would otherwise wait in silence; undefined when the answer is predicted to come quickly. */
  receipt(c: FillerContext): string | undefined {
    if (c.predictedMs < (this.o.thresholdMs ?? 600)) return undefined;
    if (c.cls.taskType === "agentic_project" || c.cls.complexity >= 0.75) return this.pick(LONG_RECEIPTS);
    if (/\?\s*$|^(?:¿|que|qué|quien|quién|cual|cuál|como|cómo|cuando|cuándo|donde|dónde|por que|por qué)\b/i.test(c.input.trim())) return this.pick(QUESTION_RECEIPTS);
    return this.pick(RECEIPTS);
  }

  /** Said when a slow tool REALLY starts (after any permission), describing what it is about to do. */
  forTool(tool: string, args: Record<string, unknown>): string | undefined {
    if (tool === "web.search") return this.pick(["Lo busco.", "Ya lo busco en internet.", "Busco eso."]);
    if (tool === "web.fetch") {
      const host = typeof args.url === "string" ? safeHost(args.url) : undefined;
      return host ? `Leo ${host}.` : "Leo la página.";
    }
    if (tool === "code.agent") return "Le paso la tarea al agente de programación; puede tardar un poco.";
    if (tool.startsWith("mcp.")) return `Le pregunto a ${tool.split(".")[1]}.`;
    return undefined;
  }
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Typical extra time from first token to the end of the first sentence (measured: short Spanish answers, ~100-200 ms). */
export const FIRST_SENTENCE_MS = 150;
/** A tool round trip (call, run, second model call) before any answer exists. */
export const TOOL_ROUND_TRIP_MS = 900;
