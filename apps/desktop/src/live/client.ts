import { ServerMessage, encodeLine, IPC_VERSION, type MemoryItemView } from "@jarvis/ipc";
import type { EconomySummary, OrchestratorEvent } from "@jarvis/protocol";

/** What the sidecar remembers (ADR-0023). */
export interface MemorySnapshot {
  enabled: boolean;
  /** Exchanges of the current chat that would go to the model with the next request. */
  conversationTurns: number;
  items: MemoryItemView[];
}

export type LiveStatus = "idle" | "connecting" | "ready" | "unavailable";
export interface LiveInfo {
  models: string[];
  offline: boolean;
  /** Local speech-to-text is configured in the sidecar. */
  voice: boolean;
  /** Engines in order; one starting with "groq:" sends audio to Groq. */
  voiceEngines: string[];
}

/** What the sidecar tells the UI about a push-to-talk clip. */
export type VoiceNotice =
  | { kind: "transcribed"; text: string; audioMs: number; latencyMs: number; engine?: string; heard?: string }
  | { kind: "rejected"; reason: string; message: string };

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  /** `message`/`reason` are optional: a WebSocket gives neither useful text, the Tauri relay explains what failed. */
  onerror: ((e?: { message?: string }) => void) | null;
  onclose: ((e?: { reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LiveClientOptions {
  /** Both default to the same-origin dev bridge; inside Tauri they come from `tauriTransport()`. */
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
  private readonly economyListeners = new Set<(s: EconomySummary | undefined) => void>();
  private readonly wakeListeners = new Set<(r: { detected: boolean; commandRan: boolean; reason?: string }) => void>();
  private readonly memoryListeners = new Set<(m: MemorySnapshot) => void>();
  private readonly voiceListeners = new Set<(n: VoiceNotice) => void>();
  private readonly statusListeners = new Set<() => void>();

  constructor(private readonly opts: LiveClientOptions = {}) {}

  onEvent(l: (e: OrchestratorEvent) => void): () => void {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  }

  onEconomy(l: (s: EconomySummary | undefined) => void): () => void {
    this.economyListeners.add(l);
    return () => this.economyListeners.delete(l);
  }

  onWakeResult(l: (r: { detected: boolean; commandRan: boolean; reason?: string }) => void): () => void {
    this.wakeListeners.add(l);
    return () => this.wakeListeners.delete(l);
  }

  onMemory(l: (m: MemorySnapshot) => void): () => void {
    this.memoryListeners.add(l);
    return () => this.memoryListeners.delete(l);
  }

  onVoice(l: (n: VoiceNotice) => void): () => void {
    this.voiceListeners.add(l);
    return () => this.voiceListeners.delete(l);
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
      this.detachSocket(); // a retry: the old connection must not be able to fail the new one when it finally closes
      const socket = (this.opts.openSocket ?? defaultOpenSocket)();
      this.socket = socket;
      socket.onopen = () => socket.send(encodeLine({ type: "hello", token, protocol: IPC_VERSION }));
      socket.onmessage = (e) => this.handle(String(e.data));
      socket.onerror = (e) => this.fail(e?.message || "conexión con el sidecar fallida");
      socket.onclose = (e) => {
        if (this.status !== "unavailable") this.fail(e?.reason ? `sidecar desconectado (${e.reason})` : "sidecar desconectado");
      };
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  submit(input: string): void {
    this.send({ type: "task.submit", input, modality: "text" });
  }

  /** `wavBase64`: PCM16 mono WAV (<= 20 s) from the push-to-talk recorder. */
  submitVoice(wavBase64: string): void {
    this.send({ type: "voice.submit", audio: wavBase64 });
  }

  /** Ask for the AI Economy aggregate; the answer arrives through `onEconomy`. */
  requestEconomy(limit = 500): void {
    this.send({ type: "economy.get", limit });
  }

  /** Wake-word stage 2: an utterance the on-device spotter liked (PCM16 mono WAV, base64). */
  verifyWake(wavBase64: string): void {
    this.send({ type: "wake.verify", audio: wavBase64 });
  }

  /** Ask for what is remembered; every memory change is answered with a fresh snapshot through `onMemory`. */
  requestMemory(): void {
    this.send({ type: "memory.get" });
  }

  forgetMemory(id: string): void {
    this.send({ type: "memory.forget", id });
  }

  clearMemory(): void {
    this.send({ type: "memory.clear" });
  }

  setMemoryEnabled(enabled: boolean): void {
    this.send({ type: "memory.toggle", enabled });
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

  private detachSocket(): void {
    const old = this.socket;
    if (!old) return;
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    this.socket = undefined;
    old.close();
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
        this.info = { models: msg.models, offline: msg.offline, voice: msg.voice, voiceEngines: msg.voiceEngines };
        this.setStatus("ready");
      } else if (msg.type === "hello.error") this.fail(msg.message);
      else if (msg.type === "error") this.lastError = msg.message;
      else if (msg.type === "wake.result") this.wakeListeners.forEach((l) => l({ detected: msg.detected, commandRan: msg.commandRan, reason: msg.reason }));
      else if (msg.type === "memory") this.memoryListeners.forEach((l) => l({ enabled: msg.enabled, conversationTurns: msg.conversationTurns, items: msg.items }));
      else if (msg.type === "economy") this.economyListeners.forEach((l) => l(msg.summary));
      else if (msg.type === "voice.transcribed") this.voiceListeners.forEach((l) => l({ kind: "transcribed", text: msg.text, audioMs: msg.audioMs, latencyMs: msg.latencyMs, ...(msg.engine ? { engine: msg.engine } : {}), ...(msg.heard ? { heard: msg.heard } : {}) }));
      else if (msg.type === "voice.rejected") this.voiceListeners.forEach((l) => l({ kind: "rejected", reason: msg.reason, message: msg.message }));
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
