import { timingSafeEqual } from "node:crypto";
import { ClientMessage, IPC_VERSION, type ServerMessage } from "@jarvis/ipc";
import type { EventBus, Orchestrator, PermissionResolver } from "@jarvis/core";

export interface SidecarServerOptions {
  token: string;
  send: (msg: ServerMessage) => void;
  /** Builds the orchestrator wired to this connection's bus and permission channel. */
  createOrchestrator: (io: { bus: EventBus; askPermission: PermissionResolver }) => Orchestrator;
  bus: EventBus;
  info: { models: string[]; offline: boolean };
  /** Unanswered permission prompts are denied after this long. */
  permissionTimeoutMs?: number;
  /** Called after a failed handshake; the host should drop the connection. */
  onFatal?: (reason: string) => void;
  log?: (line: string) => void;
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
      return this.opts.send({ type: "hello.ok", protocol: IPC_VERSION, ...this.opts.info });
    }
    if (!parsed.success) return this.opts.send({ type: "error", message: "invalid message" });

    const msg = parsed.data;
    switch (msg.type) {
      case "hello":
        return this.opts.send({ type: "error", message: "already authenticated" });
      case "task.submit":
        return this.submit(msg.input, msg.modality);
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
