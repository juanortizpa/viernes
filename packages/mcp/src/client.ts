import type { McpTransport } from "./transport";

/** Versions this client speaks, newest first. The first one is offered; the server may answer with any of them. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** Hints from the server (e.g. readOnlyHint). Untrusted: they never lower a tool's risk on their own (ADR-0025). */
  annotations?: Record<string, unknown>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

export interface McpCallResult {
  content: McpContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Incoming = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

/**
 * Minimal MCP client (JSON-RPC 2.0): initialize, tools/list, tools/call, cancellation. It offers NO client capabilities (no
 * sampling, no roots, no elicitation): a server cannot make JARVIS call a model or reveal folders. Server requests other than
 * `ping` are answered "method not found".
 */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedReason: string | undefined;
  serverInfo: { name?: string; version?: string } = {};
  protocolVersion: string | undefined;
  /** Short usage notes some servers send on initialize. Untrusted: shown to the user, never put in a system prompt. */
  instructions: string | undefined;

  constructor(
    private readonly transport: McpTransport,
    private readonly opts: { requestTimeoutMs?: number; onNotification?: (method: string, params: unknown) => void } = {},
  ) {
    transport.onMessage((m) => this.receive(m as Incoming));
    transport.onClose((reason) => {
      this.closedReason = reason;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new McpError(`conexión MCP cerrada: ${reason}`));
        this.pending.delete(id);
      }
    });
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  async initialize(clientInfo = { name: "jarvis", version: "0.1.0" }, timeoutMs?: number): Promise<void> {
    const r = (await this.request("initialize", { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo }, { timeoutMs })) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: { tools?: unknown };
      instructions?: string;
    };
    if (!r?.protocolVersion || !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(r.protocolVersion)) {
      throw new McpError(`versión de protocolo MCP no soportada: ${r?.protocolVersion ?? "ninguna"}`);
    }
    if (!r.capabilities?.tools) throw new McpError("el servidor no ofrece herramientas (capability tools)");
    this.protocolVersion = r.protocolVersion;
    this.serverInfo = r.serverInfo ?? {};
    if (typeof r.instructions === "string") this.instructions = r.instructions.slice(0, 2000);
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.request("tools/list", cursor ? { cursor } : {})) as { tools?: McpToolInfo[]; nextCursor?: string };
      for (const t of r.tools ?? []) if (t && typeof t.name === "string") out.push({ ...t, inputSchema: isObject(t.inputSchema) ? t.inputSchema : { type: "object" } });
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallResult> {
    const r = (await this.request("tools/call", { name, arguments: args }, opts)) as McpCallResult;
    return { content: Array.isArray(r?.content) ? r.content : [], ...(r?.isError ? { isError: true } : {}), ...(r?.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}) };
  }

  close(): void {
    this.transport.close();
  }

  private request(method: string, params: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.closedReason) return Promise.reject(new McpError(`conexión MCP cerrada: ${this.closedReason}`));
    if (opts.signal?.aborted) return Promise.reject(new McpError("cancelado"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        cleanup();
        this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
        reject(new McpError(`el servidor MCP no respondió a ${method} en ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      const onAbort = (): void => {
        cleanup();
        this.notify("notifications/cancelled", { requestId: id, reason: "cancelled by user" });
        reject(new McpError("cancelado"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => (cleanup(), resolve(v)),
        reject: (e) => (cleanup(), reject(e)),
        timer,
      });
      try {
        this.transport.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.closedReason) return;
    try {
      this.transport.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    } catch {
      /* closing */
    }
  }

  private receive(m: Incoming): void {
    if (!m || typeof m !== "object") return;
    if (m.method !== undefined) {
      if (m.id === undefined || m.id === null) return this.opts.onNotification?.(m.method, m.params);
      // A request from the server. Only ping is answered; this client declared no capabilities.
      const reply = m.method === "ping" ? { result: {} } : { error: { code: -32601, message: `method not supported by this client: ${m.method}` } };
      try {
        this.transport.send({ jsonrpc: "2.0", id: m.id, ...reply });
      } catch {
        /* closing */
      }
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.error) p.reject(new McpError(m.error.message ?? "error del servidor MCP", m.error.code));
    else p.resolve(m.result);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
