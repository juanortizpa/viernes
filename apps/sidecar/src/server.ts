import { timingSafeEqual } from "node:crypto";
import { ClientMessage, IPC_VERSION, type ServerMessage } from "@jarvis/ipc";
import type { EventBus, Orchestrator, PermissionResolver } from "@jarvis/core";
import type { EconomySummary } from "@jarvis/protocol";
import type { MemoryItemView } from "@jarvis/ipc";
import { VoiceRejected, matchWakeWord, prepareClip, type Transcriber } from "@jarvis/voice";

export interface SidecarServerOptions {
  token: string;
  send: (msg: ServerMessage) => void;
  /** Builds the orchestrator wired to this connection's bus and permission channel. */
  createOrchestrator: (io: { bus: EventBus; askPermission: PermissionResolver }) => Orchestrator;
  bus: EventBus;
  info: { models: string[]; offline: boolean; voiceEngines?: string[] };
  /** Local speech-to-text. Without it, `voice.submit` is answered with `voice.rejected(unavailable)`. */
  transcriber?: Transcriber;
  /** Lighter engine for wake-word verification; falls back to `transcriber`. */
  wakeTranscriber?: Transcriber;
  wakeWords?: readonly string[];
  /** Aggregates the last `limit` stored traces; undefined when the trace store cannot be listed. */
  economy?: (limit: number) => EconomySummary | undefined;
  /** The user's own view of long-term memory (ADR-0023). Without it, `memory.*` messages are answered as empty/off. */
  memory?: MemoryControl;
  /** Unanswered permission prompts are denied after this long. */
  permissionTimeoutMs?: number;
  /** Called after a failed handshake; the host should drop the connection. */
  onFatal?: (reason: string) => void;
  log?: (line: string) => void;
}

export interface MemoryControl {
  snapshot(): { enabled: boolean; conversationTurns: number; items: MemoryItemView[] };
  forget(id: string): void;
  clear(): void;
  setEnabled(enabled: boolean): void;
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Transport-agnostic sidecar endpoint (ADR-0002): feed it lines, it sends messages.
 * One instance per connection. Nothing is accepted before a valid `hello`.
 */
export class SidecarServer {
  private authed = false;
  private dead = false;
  private readonly orchestrator: Orchestrator;
  private readonly active = new Set<{ ac: AbortController; done: Promise<void> }>();
  private readonly pending = new Map<string, { resolve: (granted: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: SidecarServerOptions) {
    this.unsubscribe = opts.bus.subscribe((event) => this.opts.send({ type: "event", event }));
    this.orchestrator = opts.createOrchestrator({ bus: opts.bus, askPermission: (req) => this.ask(req.requestId) });
  }

  handleLine(line: string): void {
    if (this.dead) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return this.opts.send({ type: "error", message: "invalid JSON" });
    }
    const parsed = ClientMessage.safeParse(json);

    if (!this.authed) {
      if (!parsed.success || parsed.data.type !== "hello" || !safeEqual(parsed.data.token, this.opts.token)) {
        return this.fatal("handshake rejected");
      }
      this.authed = true;
      return this.opts.send({ type: "hello.ok", protocol: IPC_VERSION, models: this.opts.info.models, offline: this.opts.info.offline, voice: this.opts.transcriber !== undefined, voiceEngines: this.opts.info.voiceEngines ?? [] });
    }
    if (!parsed.success) return this.opts.send({ type: "error", message: "invalid message" });

    const msg = parsed.data;
    switch (msg.type) {
      case "hello":
        return this.opts.send({ type: "error", message: "already authenticated" });
      case "task.submit":
        return this.submit(msg.input, msg.modality);
      case "wake.verify":
        return this.wake(msg.audio);
      case "memory.get":
        return this.memory();
      case "memory.forget":
        this.opts.memory?.forget(msg.id);
        return this.memory();
      case "memory.clear":
        this.opts.memory?.clear();
        return this.memory();
      case "memory.toggle":
        this.opts.memory?.setEnabled(msg.enabled);
        return this.memory();
      case "economy.get":
        return this.opts.send({ type: "economy", summary: this.opts.economy?.(msg.limit) });
      case "voice.submit":
        return this.voice(msg.audio, msg.language);
      case "task.cancel":
        return this.cancelAll();
      case "permission.answer": {
        const p = this.pending.get(msg.requestId);
        if (!p) return this.opts.send({ type: "error", message: `unknown permission request ${msg.requestId}` });
        this.settle(msg.requestId, msg.granted);
      }
    }
  }

  /** Resolves when no task is running. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active].map((t) => t.done));
  }

  /** Connection dropped: cancel work and deny anything waiting on the user. */
  close(): void {
    this.dead = true;
    this.cancelAll();
    this.unsubscribe();
  }

  private submit(input: string, modality: "text" | "voice"): void {
    const ac = new AbortController();
    const entry = { ac, done: Promise.resolve() };
    entry.done = this.orchestrator
      .run(input, { modality, signal: ac.signal })
      .then(() => undefined)
      .catch((e: unknown) => this.opts.send({ type: "error", message: e instanceof Error ? e.message : String(e) }))
      .finally(() => this.active.delete(entry));
    this.active.add(entry);
  }

  /** Wake-word stage 2. Not-for-me utterances are dropped without trace; a command in the same breath is run directly. */
  private wake(audio: string): void {
    const engine = this.opts.wakeTranscriber ?? this.opts.transcriber;
    const result = (detected: boolean, commandRan: boolean, reason?: "unavailable" | "failed" | "cancelled"): void =>
      this.opts.send({ type: "wake.result", detected, commandRan, ...(reason ? { reason } : {}) });
    if (!engine) return result(false, false, "unavailable");
    const ac = new AbortController();
    const entry = { ac, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        const clip = prepareClip(new Uint8Array(Buffer.from(audio, "base64")));
        const t = await engine.transcribe(clip.wav, { signal: ac.signal });
        if (ac.signal.aborted) return result(false, false, "cancelled");
        const m = matchWakeWord(t.text, this.opts.wakeWords);
        if (!m.matched) return result(false, false); // not for the assistant: the text is dropped here
        if (!m.rest) return result(true, false);
        // The wake check used the small/fast engine; the command itself deserves the accurate one (same audio, one more pass).
        let text = m.rest;
        let heard = t;
        const main = this.opts.transcriber;
        if (main && main !== engine) {
          try {
            const better = await main.transcribe(clip.wav, { signal: ac.signal });
            const m2 = matchWakeWord(better.text, this.opts.wakeWords);
            if (m2.matched && m2.rest) (text = m2.rest), (heard = better);
            // An interpreting engine may already have dropped the wake word from what was meant: then its text IS the command.
            else if (!m2.matched && better.heard && matchWakeWord(better.heard, this.opts.wakeWords).matched && better.text) (text = better.text), (heard = better);
          } catch {
            /* keep the fast engine's text */
          }
          if (ac.signal.aborted) return result(false, false, "cancelled");
        }
        this.opts.send({ type: "voice.transcribed", text, audioMs: clip.audioMs, latencyMs: heard.latencyMs, ...(heard.language ? { language: heard.language } : {}), ...(heard.engine ? { engine: heard.engine } : {}), ...(heard.heard ? { heard: heard.heard } : {}) });
        result(true, true);
        this.submit(text.slice(0, 10_000), "voice"); // the accurate text, not the fast engine's
      } catch (e) {
        if (ac.signal.aborted) return result(false, false, "cancelled");
        if (e instanceof VoiceRejected) return result(false, false); // silence/too short: nothing to report
        this.opts.log?.(`wake verification failed: ${e instanceof Error ? e.message : String(e)}`);
        result(false, false, "failed");
      }
    })().finally(() => this.active.delete(entry));
    this.active.add(entry);
  }

  /** Transcribe a push-to-talk clip, tell the UI what was heard, then run it as a voice task. */
  private voice(audio: string, language: string | undefined): void {
    const reject = (reason: Extract<ServerMessage, { type: "voice.rejected" }>["reason"], message: string): void =>
      this.opts.send({ type: "voice.rejected", reason, message });
    if (!this.opts.transcriber) return reject("unavailable", "El reconocimiento de voz no está configurado");
    const transcriber = this.opts.transcriber;
    const ac = new AbortController();
    const entry = { ac, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        const clip = prepareClip(new Uint8Array(Buffer.from(audio, "base64")));
        const t = await transcriber.transcribe(clip.wav, { language, signal: ac.signal });
        if (ac.signal.aborted) return reject("cancelled", "Cancelado");
        if (!t.text) return reject("empty", "No entendí nada");
        this.opts.send({ type: "voice.transcribed", text: t.text, audioMs: clip.audioMs, latencyMs: t.latencyMs, ...(t.language ? { language: t.language } : {}), ...(t.engine ? { engine: t.engine } : {}), ...(t.heard ? { heard: t.heard } : {}) });
        this.submit(t.text.slice(0, 10_000), "voice");
      } catch (e) {
        if (ac.signal.aborted) return reject("cancelled", "Cancelado");
        if (e instanceof VoiceRejected) return reject(e.reason, e.message);
        this.opts.log?.(`transcription failed: ${e instanceof Error ? e.message : String(e)}`);
        reject("failed", "No pude transcribir el audio (el detalle está en la ventana negra de start.bat; o ejecuta check-voice.bat)");
      }
    })().finally(() => this.active.delete(entry));
    this.active.add(entry);
  }

  private memory(): void {
    const s = this.opts.memory?.snapshot() ?? { enabled: false, conversationTurns: 0, items: [] };
    this.opts.send({ type: "memory", ...s });
  }

  private cancelAll(): void {
    for (const t of this.active) t.ac.abort();
    for (const id of [...this.pending.keys()]) this.settle(id, false);
  }

  private ask(requestId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, false), this.opts.permissionTimeoutMs ?? 120_000);
      this.pending.set(requestId, { resolve, timer });
    });
  }

  private settle(requestId: string, granted: boolean): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(granted);
  }

  private fatal(reason: string): void {
    this.dead = true;
    this.opts.log?.(reason);
    this.opts.send({ type: "hello.error", message: reason });
    this.opts.onFatal?.(reason);
  }
}
