import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkpointAfter, checkpointBefore, type AgentCheckpoint } from "./checkpoint";
import type { AgentResult, CodingAgent } from "./types";

export interface Project {
  name: string;
  path: string;
  /** Command that proves the work is right (e.g. "pnpm test"). Written by the user in their config: trusted. */
  verify?: string;
}

export interface VerifyResult {
  ok: boolean;
  outputTail: string;
}

/** Runs the project's own check. Its exit code is the evaluator (ADR-0012): no LLM judges whether the code works. */
export function runVerify(command: string, cwd: string, timeoutMs = 300_000, signal?: AbortSignal): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "";
    const add = (d: Buffer): void => void (out = (out + d.toString("utf8")).slice(-4000));
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const kill = (): void => {
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => resolve({ ok: false, outputTail: e.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, outputTail: out.trim().split("\n").slice(-30).join("\n") });
    });
  });
}

export function gitDiffStat(cwd: string): string | undefined {
  if (!existsSync(join(cwd, ".git"))) return undefined;
  const r = spawnSync("git", ["diff", "--stat", "--no-color"], { cwd, encoding: "utf8", windowsHide: true });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8", windowsHide: true });
  const added = untracked.status === 0 ? untracked.stdout.split("\n").filter(Boolean) : [];
  const stat = r.status === 0 ? r.stdout.trim().split("\n").pop()?.trim() : undefined;
  return [stat, added.length ? `${added.length} archivo(s) nuevo(s): ${added.slice(0, 5).join(", ")}` : ""].filter(Boolean).join(" · ") || "sin cambios";
}

export interface Attempt {
  agent: string;
  ok: boolean;
  /** Why it did not count as done (agent failure or verification failure). */
  reason?: string;
  verified?: boolean;
}

export interface CodingTaskResult {
  ok: boolean;
  /** What the final agent says it did. */
  summary: string;
  agent?: string;
  attempts: Attempt[];
  /** `git diff --stat` style summary when the project is a git repo. */
  changes?: string;
  verify?: VerifyResult;
  /** A restore point was saved before the agents ran: "deshacé los cambios" can undo this run (ADR-0026). */
  undoable?: boolean;
}

/** The instructions every agent gets. Short, Spanish, and with the boundaries JARVIS needs. */
export function buildPrompt(task: string, project: Project, previous?: { agent: string; reason: string; summary: string }): string {
  return [
    `Trabajás en el proyecto «${project.name}» (la carpeta actual). Tarea del usuario: ${task}`,
    "Reglas: trabajá solo dentro de esta carpeta; no hagas commits, push ni instales nada global; si algo es destructivo, no lo hagas y explicalo.",
    ...(project.verify ? [`Se va a comprobar el resultado con: ${project.verify}`] : []),
    ...(previous
      ? [`Otro asistente (${previous.agent}) ya lo intentó y no alcanzó: ${previous.reason}. Sus cambios siguen en la carpeta: revisalos y terminá la tarea.${previous.summary ? ` Lo que dijo: ${previous.summary.slice(0, 400)}` : ""}`]
      : []),
    "Al terminar respondé en español, en 2-3 frases, qué cambiaste.",
  ].join("\n");
}

export interface RunCodingTaskOptions {
  task: string;
  project: Project;
  /** Cheapest first (e.g. Gemini CLI, then Claude Code). */
  agents: readonly CodingAgent[];
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: string) => void;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  verify?: (command: string, cwd: string, signal?: AbortSignal) => Promise<VerifyResult>;
  /** Save a git restore point before and after the run (default true; a non-git folder simply has none). */
  checkpoints?: boolean;
}

/**
 * Cheapest agent first; the project's verify command (if any) is the judge. Escalate to the next agent when the agent failed,
 * hit a quota, hung, or its work does not pass verification. The next agent continues from the files as they are, told what
 * happened. A stuck agent that already did the work still counts: verification runs even after a timeout.
 */
export async function runCodingTask(o: RunCodingTaskOptions): Promise<CodingTaskResult> {
  let cp: AgentCheckpoint | undefined;
  if (o.checkpoints !== false) {
    try {
      cp = checkpointBefore(o.project.path, o.task);
      if (cp) o.onProgress?.("Punto de restauración guardado");
    } catch (e) {
      o.onProgress?.("Sin punto de restauración", e instanceof Error ? e.message : String(e)); // never blocks the work
    }
  }
  const r = await runChain(o);
  if (!cp) return r;
  try {
    checkpointAfter(cp);
    return { ...r, undoable: true };
  } catch {
    return r;
  }
}

async function runChain(o: RunCodingTaskOptions): Promise<CodingTaskResult> {
  const verify = o.verify ?? ((cmd: string, cwd: string, signal?: AbortSignal) => runVerify(cmd, cwd, undefined, signal));
  const attempts: Attempt[] = [];
  let previous: { agent: string; reason: string; summary: string } | undefined;
  let last: { agent: string; res: AgentResult; v?: VerifyResult } | undefined;
  for (const agent of o.agents) {
    if (o.signal?.aborted) break;
    o.onProgress?.(`${label(agent.name)}: empezando`, previous ? `antes falló ${label(previous.agent)}: ${previous.reason}` : undefined);
    const res = await agent.run({
      prompt: buildPrompt(o.task, o.project, previous),
      cwd: o.project.path,
      signal: o.signal,
      timeoutMs: o.timeoutMs,
      idleTimeoutMs: o.idleTimeoutMs,
      onProgress: (stage, detail) => o.onProgress?.(`${label(agent.name)}: ${stage}`, detail),
    });
    if (res.stoppedBy === "cancel" || o.signal?.aborted) {
      attempts.push({ agent: agent.name, ok: false, reason: "cancelado" });
      return { ok: false, summary: "Cancelado.", agent: agent.name, attempts, changes: gitDiffStat(o.project.path) };
    }
    let v: VerifyResult | undefined;
    // Verify even when the agent hung or errored: the edit may already be there.
    if (o.project.verify && res.stoppedBy !== "spawn-error") {
      o.onProgress?.(`Comprobando con «${o.project.verify}»`);
      v = await verify(o.project.verify, o.project.path, o.signal);
    }
    const done = o.project.verify ? v?.ok === true : res.ok;
    const reason = done ? undefined : v && !v.ok ? `la comprobación falló:\n${v.outputTail.slice(-600)}` : (res.failure ?? "no terminó bien");
    attempts.push({ agent: agent.name, ok: done, ...(reason ? { reason } : {}), ...(v ? { verified: v.ok } : {}) });
    last = { agent: agent.name, res, ...(v ? { v } : {}) };
    if (done) return { ok: true, summary: res.summary || "Listo.", agent: agent.name, attempts, changes: gitDiffStat(o.project.path), ...(v ? { verify: v } : {}) };
    previous = { agent: agent.name, reason: reason!, summary: res.summary };
  }
  return {
    ok: false,
    summary: last ? `No lo logré. ${last.res.summary || ""}`.trim() : "No hay ningún agente de programación disponible (instalá Gemini CLI o Claude Code).",
    ...(last ? { agent: last.agent } : {}),
    attempts,
    changes: gitDiffStat(o.project.path),
    ...(last?.v ? { verify: last.v } : {}),
  };
}

const label = (n: string): string => (n === "gemini" ? "Gemini" : n === "claude" ? "Claude Code" : n);
