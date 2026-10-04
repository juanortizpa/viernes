import { describeTool } from "./describe";
import { planSpawn, runLines } from "./process";
import type { AgentResult, AgentRunOptions, CodingAgent } from "./types";

export interface ClaudeCodeOptions {
  /** `claude` (Claude Code, logged in with the user's plan). */
  binary?: string;
  model?: string;
  /** "acceptEdits": file edits auto-approved; other tools follow Claude Code's own rules. */
  permissionMode?: "acceptEdits" | "default" | "bypassPermissions";
}

const LIMIT = /usage limit|limit reached|rate.?limit|quota|\b429\b|overloaded/i;

/**
 * Claude Code headless (`-p --output-format stream-json --verbose`), checked against the real stream: `system/init`,
 * `assistant` {message.content: text | tool_use{name,input}}, `user` (tool results), `result` {subtype, is_error, result}.
 * The task arrives on stdin. Uses the user's own subscription limits.
 */
export class ClaudeCodeAgent implements CodingAgent {
  readonly name = "claude";
  constructor(private readonly o: ClaudeCodeOptions = {}) {}

  async run(r: AgentRunOptions): Promise<AgentResult> {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", this.o.permissionMode ?? "acceptEdits", ...(this.o.model ? ["--model", this.o.model] : [])];
    let lastText = "";
    let final: { is_error?: boolean; subtype?: string; result?: string } | undefined;
    const touched = new Set<string>();
    const res = await runLines(planSpawn(this.o.binary ?? "claude", args), {
      cwd: r.cwd,
      stdin: r.prompt,
      signal: r.signal,
      timeoutMs: r.timeoutMs ?? 600_000,
      idleTimeoutMs: r.idleTimeoutMs ?? 180_000,
      onLine: (line) => {
        let e: { type?: string; message?: { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] }; is_error?: boolean; subtype?: string; result?: string };
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (e.type === "assistant") {
          for (const c of e.message?.content ?? []) {
            if (c.type === "text" && c.text) lastText = c.text;
            else if (c.type === "tool_use" && c.name) {
              const d = describeTool(c.name, c.input);
              if (d.file) touched.add(d.file);
              r.onProgress?.(d.stage);
            }
          }
        } else if (e.type === "result") final = e;
      },
    });
    const text = (final?.result ?? lastText).trim();
    const limited = LIMIT.test(`${final?.is_error ? text : ""} ${res.stderrTail}`);
    const ok = res.stoppedBy === "exit" && res.code === 0 && final !== undefined && !final.is_error;
    const failure = ok
      ? undefined
      : res.stoppedBy === "spawn-error"
        ? `no se pudo ejecutar claude (${res.spawnError}); ¿está instalado Claude Code e iniciada la sesión?`
        : res.stoppedBy === "idle"
          ? "Claude Code dejó de responder (sin actividad)"
          : res.stoppedBy === "timeout"
            ? "Claude Code superó el tiempo máximo"
            : res.stoppedBy === "cancel"
              ? "cancelado"
              : (final?.is_error ? text || final.subtype : res.stderrTail.trim().split("\n").pop()) || `claude terminó con código ${res.code}`;
    return { ok, summary: text.slice(0, 1500), ...(failure ? { failure } : {}), stoppedBy: res.stoppedBy, ...(limited ? { limited } : {}), touched: [...touched] };
  }
}
