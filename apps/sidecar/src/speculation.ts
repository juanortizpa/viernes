import { EventBus, normalizeText } from "@jarvis/core";
import type { OrchestratorEvent } from "@jarvis/protocol";

/**
 * Thinking from the first words (ADR-0029). While the user is still talking, a partial transcript that looks complete starts the
 * real orchestrator in SPECULATIVE mode: its events are held back here, and nothing that changes the world runs (the orchestrator
 * gates every tool above `read`). When the user stops:
 * - the final transcript says the same words → the held events are released in order and the run simply continues (the answer
 *   may already be half written);
 * - it does not → the run is aborted and its events dropped; the normal path starts. The user never sees a wrong guess.
 */
export class HoldingBus extends EventBus {
  private held: OrchestratorEvent[] = [];
  private state: "holding" | "released" | "dropped" = "holding";

  constructor(private readonly target: EventBus) {
    super();
  }

  override publish(e: OrchestratorEvent): void {
    if (this.state === "released") this.target.publish(e);
    else if (this.state === "holding") this.held.push(e);
  }

  release(): void {
    if (this.state !== "holding") return;
    this.state = "released";
    for (const e of this.held) this.target.publish(e);
    this.held = [];
  }

  drop(): void {
    this.state = "dropped";
    this.held = [];
  }
}

/** Same request? Punctuation, accents, case, fillers at the edges and the wake word do not change what was asked. */
export function sameRequest(a: string, b: string, wakeWords: readonly string[] = ["jarvis"]): boolean {
  const strip = (s: string): string => {
    let t = normalizeText(s).replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
    for (const w of wakeWords) t = t.replace(new RegExp(`^(?:(?:oye|hey|che)\\s+)?${normalizeText(w)}\\s*`), "");
    return t.replace(/^(?:eh+|em+|bueno|a ver)\s+/, "").trim();
  };
  const x = strip(a);
  return x.length > 0 && x === strip(b);
}

export type SpeculativeStart = (text: string, o: { bus: EventBus; speculation: Promise<boolean>; signal: AbortSignal }) => Promise<unknown>;

interface Guess {
  text: string;
  bus: HoldingBus;
  ac: AbortController;
  decide: (ok: boolean) => void;
  done: Promise<unknown>;
}

export interface SpeculatorOptions {
  realBus: EventBus;
  start: SpeculativeStart;
  /** Guesses per utterance at most: each one can cost a (free-tier) model call. */
  maxGuesses?: number;
  /** Text worth guessing on (e.g. not a local command, which costs nothing to run after confirmation anyway). */
  worthIt?: (text: string) => boolean;
  wakeWords?: readonly string[];
}

export class Speculator {
  private current: Guess | undefined;
  private guesses = 0;
  readonly stats = { started: 0, committed: 0, discarded: 0 };

  constructor(private readonly o: SpeculatorOptions) {}

  /** A partial transcript arrived. Guess only on one that looks complete (the user paused) and differs from the current guess. */
  onPartial(text: string, complete: boolean): void {
    if (!complete || !text.trim()) return;
    if (this.current && sameRequest(this.current.text, text, this.o.wakeWords)) return;
    if (this.o.worthIt && !this.o.worthIt(text)) return;
    if (this.guesses >= (this.o.maxGuesses ?? 2)) return;
    this.discard();
    this.guesses++;
    this.stats.started++;
    const bus = new HoldingBus(this.o.realBus);
    const ac = new AbortController();
    let decide: (ok: boolean) => void = () => {};
    const speculation = new Promise<boolean>((r) => (decide = r));
    const done = this.o.start(text, { bus, speculation, signal: ac.signal }).catch(() => undefined);
    this.current = { text, bus, ac, decide, done };
  }

  /**
   * The final transcript. Returns true when the running guess was for exactly this request: it is confirmed and its held events
   * flow to the UI. Otherwise any guess is discarded and the caller runs the request normally.
   */
  confirm(finalText: string): { confirmed: true; done: Promise<unknown> } | { confirmed: false } {
    const g = this.current;
    if (g && sameRequest(g.text, finalText, this.o.wakeWords)) {
      this.current = undefined;
      this.stats.committed++;
      g.bus.release();
      g.decide(true);
      return { confirmed: true, done: g.done };
    }
    this.discard();
    return { confirmed: false };
  }

  discard(): void {
    const g = this.current;
    if (!g) return;
    this.current = undefined;
    this.stats.discarded++;
    g.bus.drop();
    g.decide(false);
    g.ac.abort();
  }

  /** Text of the guess in progress (for tests and diagnostics). */
  get guessing(): string | undefined {
    return this.current?.text;
  }
}
