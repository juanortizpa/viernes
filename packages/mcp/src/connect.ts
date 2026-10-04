import type { AnyTool } from "@jarvis/tools";
import { McpClient } from "./client";
import { mcpTools, SERVER_NAME, type McpServerConfig } from "./tools";
import { StdioTransport, type McpTransport, type SpawnPlan } from "./transport";

export interface McpServerStatus {
  name: string;
  ok: boolean;
  /** Tool names as offered to the model (`mcp.<server>.<tool>`). */
  tools: string[];
  error?: string;
  /** Server-provided usage notes (untrusted; for the user, never for a system prompt). */
  instructions?: string;
}

export interface McpConnections {
  tools: AnyTool[];
  servers: McpServerStatus[];
  close(): void;
}

export interface ConnectOptions {
  /** Process environment used to start servers and to expand "$NAME" values. */
  env: Record<string, string | undefined>;
  /** Turns a command into something spawnable on this OS (Windows .cmd shims). */
  plan: (command: string, args: readonly string[]) => SpawnPlan;
  /** Tests inject in-memory transports. */
  transport?: (name: string, cfg: McpServerConfig) => McpTransport;
  log?: (line: string) => void;
}

/** "$NAME" → the value of NAME in JARVIS's environment; anything else is literal. A missing variable is an error, not "". */
export function expandEnv(values: Record<string, string>, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(v);
    if (!m) out[k] = v;
    else {
      const val = env[m[1]!];
      if (val === undefined || val === "") throw new Error(`falta la variable de entorno ${m[1]} (pedida por ${k})`);
      out[k] = val;
    }
  }
  return out;
}

/** Starts every enabled server in parallel. A server that fails is reported and skipped; it never stops JARVIS from starting. */
export async function connectMcpServers(servers: Record<string, McpServerConfig>, o: ConnectOptions): Promise<McpConnections> {
  const clients: McpClient[] = [];
  const entries = Object.entries(servers).filter(([, c]) => c.enabled);
  const results = await Promise.all(
    entries.map(async ([name, cfg]): Promise<{ status: McpServerStatus; tools: AnyTool[] }> => {
      if (!SERVER_NAME.test(name)) return { status: { name, ok: false, tools: [], error: "nombre inválido (letras, números, - y _; hasta 20)" }, tools: [] };
      let client: McpClient | undefined;
      try {
        const transport =
          o.transport?.(name, cfg) ??
          new StdioTransport(o.plan(cfg.command, cfg.args), { ...(cfg.cwd ? { cwd: cfg.cwd } : {}), env: { ...baseEnv(o.env), ...expandEnv(cfg.env, o.env) } });
        client = new McpClient(transport, { requestTimeoutMs: cfg.timeoutMs, onNotification: (m) => m === "notifications/tools/list_changed" && o.log?.(`MCP ${name}: cambió su lista de herramientas (se aplica al reiniciar)`) });
        clients.push(client);
        await client.initialize(undefined, cfg.startupTimeoutMs);
        const tools = mcpTools(name, client, await client.listTools(), cfg);
        o.log?.(`MCP ${name}: conectado (${client.serverInfo.name ?? "?"} ${client.serverInfo.version ?? ""}), ${tools.length} herramienta(s)`);
        return { status: { name, ok: true, tools: tools.map((t) => t.name), ...(client.instructions ? { instructions: client.instructions } : {}) }, tools };
      } catch (e) {
        client?.close();
        const error = e instanceof Error ? e.message : String(e);
        o.log?.(`MCP ${name}: no conectado: ${error}`);
        return { status: { name, ok: false, tools: [], error }, tools: [] };
      }
    }),
  );
  return {
    tools: results.flatMap((r) => r.tools),
    servers: results.map((r) => r.status),
    close: () => clients.forEach((c) => c.close()),
  };
}

/** What a process needs to run on Windows/POSIX (paths, temp, profile). JARVIS's own API keys are NOT passed to third-party servers. */
const BASE_ENV = /^(path|pathext|systemroot|systemdrive|windir|comspec|home|homedrive|homepath|userprofile|username|user|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|commonprogramfiles|temp|tmp|tmpdir|lang|lc_all|shell|os|number_of_processors|processor_architecture|xdg_[a-z_]+)$/i;

export function baseEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && BASE_ENV.test(k))) as NodeJS.ProcessEnv;
}
