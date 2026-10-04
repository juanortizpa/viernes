import { ServerMessage, encodeLine, IPC_VERSION } from "@jarvis/ipc";
import type { OrchestratorEvent } from "@jarvis/protocol";

export type LiveStatus = "idle" | "connecting" | "ready" | "unavailable";
export interface LiveInfo {
  models: string[];
  offline: boolean;
}

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LiveClientOptions {
  /** Both default to the same-origin dev bridge. */
  fetchToken?: () => Promise<string>;
  openSocket?: () => SocketLike;
}

const defaultFetchToken = async (): Promise<string> => {
  const res = await fetch("/__jarvis/token");
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  return ((await res.json()) as { token: string }).token;
};

const defaultOpenSocket = (): SocketLike => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${proto}://${location.host}/__jarvis/ws`) as unknown as SocketLike;
};

/** Browser side of the sidecar IPC. Events are the same OrchestratorEvents the demo emits. */
export class LiveClient {
  status: LiveStatus = "idle";
  info?: LiveInfo;
  lastError?: string;
  private socket?: SocketLike;
  private readonly eventListeners = new Set<(e: OrchestratorEvent) => void>();
  private readonly statusListeners = new Set<() => void>();

  constructor(private readonly opts: LiveClientOptions = {}) {}

  onEvent(l: (e: OrchestratorEvent) => void): () => void {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  }

  onStatus(l: () => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  async connect(): Promise<void> {
    if (this.status === "connecting" || this.status === "ready") return;
    this.setStatus("connecting");
    try {
      const token = await (this.opts.fetchToken ?? defaultFetchToken)();
      const socket = (this.opts.openSocket ?? defaultOpenSocket)();
      this.socket = socket;
      socket.onopen = () => socket.send(encodeLine({ type: "hello", token, protocol: IPC_VERSION }));
      socket.onmessage = (e) => this.handle(String(e.data));
      socket.onerror = () => this.fail("conexión con el sidecar fallida");
      socket.onclose = () => {
        if (this.status !== "unavailable") this.fail("sidecar desconectado");
      };
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  submit(input: string): void {
    this.send({ type: "task.submit", input, modality: "text" });
  }

  cancel(): void {
    this.send({ type: "task.cancel" });
  }

  answerPermission(requestId: string, granted: boolean): void {
    this.send({ type: "permission.answer", requestId, granted });
  }

  close(): void {
    this.socket?.close();
  }

  private send(msg: unknown): void {
    if (this.status !== "ready" || !this.socket) throw new Error("sidecar not ready");
    this.socket.send(encodeLine(msg));
  }

  private handle(raw: string): void {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = ServerMessage.safeParse(JSON.parse(line));
      } catch {
        parsed = undefined;
      }
      if (!parsed?.success) {
        this.lastError = "mensaje inválido del sidecar";
        continue;
      }
      const msg = parsed.data;
      if (msg.type === "hello.ok") {
        this.info = { models: msg.models, offline: msg.offline };
        this.setStatus("ready");
      } else if (msg.type === "hello.error") this.fail(msg.message);
      else if (msg.type === "error") this.lastError = msg.message;
      else this.eventListeners.forEach((l) => l(msg.event));
    }
  }

  private fail(message: string): void {
    this.lastError = message;
    this.setStatus("unavailable");
  }

  private setStatus(s: LiveStatus): void {
    this.status = s;
    this.statusListeners.forEach((l) => l());
  }
}
