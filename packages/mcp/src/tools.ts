import { z } from "zod";
import { PermissionLevel } from "@jarvis/protocol";
import type { Tool, ToolResult } from "@jarvis/tools";
import type { McpCallResult, McpClient, McpToolInfo } from "./client";

/** One MCP server as the user writes it in jarvis.config.json → mcp.servers. Everything here is the user's own (trusted) config. */
export const McpServerConfig = z.object({
  /** Executable (e.g. "npx", "uvx", "node"). Arguments never come from a model. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Extra environment. A value "$NAME" is read from JARVIS's environment (jarvis.env), so secrets stay out of the config file. */
  env: z.record(z.string()).default({}),
  cwd: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  /**
   * Risk of every tool of this server (ADR-0005). Default `sensitive`: the policy engine asks before each call. Lower it only for
   * servers you trust; `readOnlyTools` marks individual tools as `read` (no confirmation).
   */
  risk: PermissionLevel.default("sensitive"),
  readOnlyTools: z.array(z.string()).default([]),
  /** Only these tools are offered (default: all). */
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /** First start may download the server (npx/uvx): give it time. */
  startupTimeoutMs: z.number().int().min(1_000).max(600_000).default(90_000),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,19}$/i;
/** OpenAI-style function names allow [A-Za-z0-9_-]{1,64}; dots become "__" on the wire, so the JARVIS name must stay well under that. */
const MAX_NAME = 56;
const MAX_OUTPUT_CHARS = 20_000;

/** `mcp.<server>.<tool>` with characters the model APIs accept. Unique within the server (a numeric suffix on collision). */
export function toolNameFor(server: string, tool: string, taken: Set<string>): string {
  const base = `mcp.${server}.`;
  const safe = tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_NAME - base.length) || "tool";
  let name = base + safe;
  for (let i = 2; taken.has(name); i++) name = `${base}${safe.slice(0, MAX_NAME - base.length - String(i).length - 1)}_${i}`;
  taken.add(name);
  return name;
}

/** The text the model sees of a call result. Non-text blocks are named, not inlined (images are not sent back to the model). */
export function resultText(r: McpCallResult): string {
  const parts = r.content.map((b) => {
    if (b.type === "text" && typeof b.text === "string") return b.text;
    if (b.type === "resource" && b.resource) return b.resource.text ?? `[recurso ${b.resource.uri ?? ""}]`;
    if (b.type === "resource_link") return `[enlace a recurso]`;
    return `[${b.type}${b.mimeType ? ` ${b.mimeType}` : ""} omitido]`;
  });
  let text = parts.join("\n").trim();
  if (!text && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + "…[truncado]" : text;
}

const firstLine = (s: string, n = 160): string => {
  const l = s.split("\n").find((x) => x.trim())?.trim() ?? "";
  return l.length > n ? l.slice(0, n - 1) + "…" : l;
};

/**
 * MCP tools as JARVIS tools. They run through the same `invokeTool` path as any other (validation, policy, permission, taint):
 * MCP is only an adapter at the edge (ADR-0025). Every result is `untrusted_external` — a server returns third-party content
 * (web pages, issues, files) that may carry prompt injection.
 */
export function mcpTools(server: string, client: Pick<McpClient, "callTool" | "closed">, infos: readonly McpToolInfo[], cfg: Pick<McpServerConfig, "risk" | "readOnlyTools" | "include" | "exclude" | "timeoutMs">): Tool<Record<string, unknown>, string>[] {
  const taken = new Set<string>();
  const offered = infos.filter((t) => (!cfg.include || cfg.include.includes(t.name)) && !cfg.exclude.includes(t.name));
  return offered.map((info) => {
    const risk = cfg.readOnlyTools.includes(info.name) ? "read" : cfg.risk;
    const description = `[MCP ${server}] ${(info.description ?? info.name).replace(/\s+/g, " ").trim()}`.slice(0, 1000);
    return {
      name: toolNameFor(server, info.name, taken),
      description,
      risk,
      reversible: risk === "read",
      input: z.record(z.unknown()),
      inputSchema: info.inputSchema,
      async run(args, ctx): Promise<ToolResult<string>> {
        if (client.closed) return { ok: false, summary: `el servidor MCP «${server}» no está conectado`, provenance: "system" };
        try {
          const r = await client.callTool(info.name, args, { signal: ctx.signal, timeoutMs: cfg.timeoutMs });
          const text = resultText(r);
          return { ok: !r.isError, summary: r.isError ? `${server}/${info.name} falló: ${firstLine(text) || "sin detalle"}` : `${server}/${info.name}: ${firstLine(text) || "hecho"}`, output: text, provenance: "untrusted_external" };
        } catch (e) {
          // A JSON-RPC error message is written by the server: as untrusted as its results.
          return { ok: false, summary: `${server}/${info.name}: ${e instanceof Error ? e.message : String(e)}`, provenance: "untrusted_external" };
        }
      },
    };
  });
}
