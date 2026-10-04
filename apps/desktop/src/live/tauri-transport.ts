import { Channel, invoke } from "@tauri-apps/api/core";
import type { LiveClientOptions, SocketLike } from "./client";

/**
 * Inside the Tauri island the shell spawns the sidecar and relays its stdio (ADR-0021), so the UI speaks the very same
 * NDJSON protocol as with the browser's dev bridge: this file only adapts the shell's commands to `SocketLike`.
 */

/** What the shell pushes on the channel given to `sidecar_start` (mirrors `SidecarMessage` in src-tauri/src/sidecar.rs). */
export type SidecarMessage = { kind: "line"; line: string } | { kind: "exit"; code: number | null };

export interface ChannelLike {
  onmessage: (m: SidecarMessage) => void;
}

/** The two Tauri primitives the transport needs; injected so tests run without a shell. */
export interface TauriBridge {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  channel(): ChannelLike;
}

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const defaultBridge = (): TauriBridge => ({
  invoke: (cmd, args) => invoke(cmd, args),
  channel: () => new Channel<SidecarMessage>(),
});

const errorText = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : "el shell no pudo arrancar el sidecar");

/** One sidecar process per socket: opening starts a fresh one, closing stops it. */
export class TauriSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e?: { message?: string }) => void) | null = null;
  onclose: ((e?: { reason?: string }) => void) | null = null;
  private generation?: number;
  private closed = false;
  /** Sends are chained: async commands may run in parallel in the shell, but protocol lines must keep their order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly bridge: TauriBridge) {
    const channel = bridge.channel();
    channel.onmessage = (m) => {
      if (this.closed) return;
      if (m.kind === "line") this.onmessage?.({ data: m.line });
      else this.finish(m.code === null ? "terminó" : `terminó con código ${m.code}`);
    };
    bridge.invoke<number>("sidecar_start", { onMessage: channel }).then(
      (generation) => {
        this.generation = generation;
        if (this.closed) void this.stop();
        else this.onopen?.();
      },
      (e) => {
        if (this.closed) return;
        this.onerror?.({ message: errorText(e) });
        this.finish();
      },
    );
  }

  send(data: string): void {
    const generation = this.generation;
    if (generation === undefined || this.closed) return;
    this.queue = this.queue
      .then(() => this.bridge.invoke("sidecar_send", { generation, line: data }))
      .catch((e) => {
        if (this.closed) return;
        this.onerror?.({ message: errorText(e) });
        this.finish();
      });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.stop();
  }

  private stop(): Promise<unknown> {
    const generation = this.generation;
    return generation === undefined ? Promise.resolve() : this.bridge.invoke("sidecar_stop", { generation }).catch(() => undefined);
  }

  private finish(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(reason ? { reason } : undefined);
  }
}

/** `LiveClient` options for the Tauri shell. */
export function tauriTransport(bridge: TauriBridge = defaultBridge()): Required<LiveClientOptions> {
  return {
    fetchToken: () => bridge.invoke<string>("sidecar_token"),
    openSocket: () => new TauriSocket(bridge),
  };
}
