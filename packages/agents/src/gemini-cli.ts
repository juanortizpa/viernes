import { describeTool } from "./describe";
import { planSpawn, runLines } from "./process";
import type { AgentResult, AgentRunOptions, CodingAgent } from "./types";

export interface GeminiCliOptions {
  /** `gemini` (npm i -g @google/gemini-cli). Free with a Google account. */
  binary?: string;
  model?: string;
  /** "auto_edit": edits auto-approved, shell commands are not. "yolo": everything (only if you accept it). */
  approval?: "auto_edit" | "yolo";
}

const LIMIT = /quota|resource[_ ]exhausted|rate.?limit|\b429\b|exceeded your current/i;

/**
 * Gemini CLI in headless mode (`-o stream-json`), verified against v0.62: events `init`, `message`, `tool_use`
 * {tool_name, parameters}, `tool_result`, `result` {status, error?}. Headless runs refuse untrusted folders, so the project
 * (one the user configured) is trusted for this run through GEMINI_CLI_TRUST_WORKSPACE.
 */
export class GeminiCliAgent implements CodingAgent {
  readonly name = "gemini";
  constructor(private readonly o: GeminiCliOptions = {}) {}

  async run(r: AgentRunOptions): Promise<AgentResult> {
    const args = ["-o", "stream-json", "--approval-mode", this.o.approval ?? "auto_edit", ...(this.o.model ? ["-m", this.o.model] : [])];
    let text = "";
    let status: string | undefined;
    let error: string | undefined;
    const touched = new Set<string>();
    const res = await runLines(planSpawn(this.o.binary ?? "gemini", args), {
      cwd: r.cwd,
      env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" },
      stdin: r.prompt,
      signal: r.signal,
      timeoutMs: r.timeoutMs ?? 600_000,
      idleTimeoutMs: r.idleTimeoutMs ?? 120_000,
      onLine: (line) => {
        let e: { type?: string; role?: string; content?: string; delta?: boolean; tool_name?: string; parameters?: Record<string, unknown>; status?: string; error?: { message?: string } };
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (e.type === "tool_use" && e.tool_name) {
          const d = describeTool(e.tool_name, e.parameters);
          if (d.file) touched.add(d.file);
          r.onProgress?.(d.stage);
        } else if (e.type === "message" && e.role === "assistant" && typeof e.content === "string") text = e.delta ? text + e.content : e.content;
        else if (e.type === "result") {
          status = e.status;
          error = e.error?.message;
        }
      },
    });
    const limited = LIMIT.test(`${error ?? ""} ${res.stderrTail}`);
    const ok = res.stoppedBy === "exit" && res.code === 0 && status !== "error";
    const failure = ok
      ? undefined
      : res.stoppedBy === "spawn-error"
        ? `no se pudo ejecutar gemini (${res.spawnError}); ¿está instalado? npm i -g @google/gemini-cli`
        : res.stoppedBy === "idle"
          ? "Gemini dejó de responder (sin actividad)"
          : res.stoppedBy === "timeout"
            ? "Gemini superó el tiempo máximo"
            : res.stoppedBy === "cancel"
              ? "cancelado"
              : (error ?? (res.stderrTail.trim().split("\n").pop() || `gemini terminó con código ${res.code}`));
    return { ok, summary: text.trim().slice(0, 1500), ...(failure ? { failure } : {}), stoppedBy: res.stoppedBy, ...(limited ? { limited } : {}), touched: [...touched] };
  }
}
