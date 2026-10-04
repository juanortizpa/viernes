import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ClaudeCodeAgent, GeminiCliAgent, isInstalled, runCodingTask, type CodingAgent, type CodingTaskResult, type Project } from "@jarvis/agents";
import { normalizeText, type Intent } from "@jarvis/core";
import type { Tool } from "@jarvis/tools";
import type { Config } from "./config";

/** The configured agents that are actually installed, in the configured (cheapest-first) order. */
export function availableAgents(cfg: Config["coding"], installed: (binary: string) => boolean = (b) => (isAbsolute(b) ? existsSync(b) : isInstalled(b))): CodingAgent[] {
  const out: CodingAgent[] = [];
  for (const name of cfg.agents) {
    if (name === "gemini" && installed(cfg.gemini.binary)) out.push(new GeminiCliAgent({ binary: cfg.gemini.binary, model: cfg.gemini.model, approval: cfg.gemini.approval }));
    if (name === "claude" && installed(cfg.claude.binary)) out.push(new ClaudeCodeAgent({ binary: cfg.claude.binary, model: cfg.claude.model, permissionMode: cfg.claude.permissionMode }));
  }
  return out;
}

/** Resolve a spoken/typed project name against the configured aliases (accent/case-insensitive). Unknown names are refused. */
export function resolveProject(cfg: Config["coding"], name: string | undefined, workspace: string): Project | { error: string } {
  const entries = Object.entries(cfg.projects);
  const pick = name ?? cfg.defaultProject;
  if (!pick) {
    mkdirSync(workspace, { recursive: true });
    return { name: "espacio de trabajo", path: workspace };
  }
  const key = normalizeText(pick);
  const hit = entries.find(([alias]) => normalizeText(alias) === key) ?? entries.find(([alias]) => normalizeText(alias).startsWith(key) || key.startsWith(normalizeText(alias)));
  if (!hit) return { error: `No conozco el proyecto «${pick}». ${entries.length ? `Los configurados son: ${entries.map(([a]) => a).join(", ")}.` : "Todavía no hay proyectos configurados (coding.projects en jarvis.config.json)."}` };
  const [alias, p] = hit;
  if (!existsSync(p.path)) return { error: `La carpeta del proyecto «${alias}» no existe: ${p.path}` };
  return { name: alias, path: p.path, ...(p.verify ? { verify: p.verify } : {}) };
}

/**
 * `code.agent`: delegate a programming task to a coding agent in one of the user's projects. Sensitive (it edits files and may
 * run commands), so the policy engine asks every time. Its output is model text shaped by the repository's contents, so it is
 * marked untrusted: anything sensitive that follows in the same task needs confirmation (ADR-0005).
 */
export function makeCodeAgentTool(cfg: Config["coding"], workspace: string, agents: () => CodingAgent[] = () => availableAgents(cfg)): Tool<{ task: string; project?: string }, CodingTaskResult> {
  const names = Object.keys(cfg.projects);
  return {
    name: "code.agent",
    description: `Delegate a programming task (edit code, fix bugs, run tests, write a script) to a coding agent working inside one of the user's projects${names.length ? ` (${names.join(", ")})` : ""}. Omit project for a standalone script.`,
    risk: "sensitive",
    reversible: false,
    input: z.object({ task: z.string().min(3).max(4000), project: z.string().min(1).max(80).optional() }),
    async run({ task, project }, ctx) {
      const p = resolveProject(cfg, project, workspace);
      if ("error" in p) return { ok: false, summary: p.error, provenance: "system" };
      const list = agents();
      if (list.length === 0) return { ok: false, summary: "No encuentro Gemini CLI ni Claude Code instalados. Instalá Gemini CLI: npm i -g @google/gemini-cli (y ejecutá «gemini» una vez para iniciar sesión).", provenance: "system" };
      const r = await runCodingTask({ task, project: p, agents: list, signal: ctx.signal, onProgress: ctx.progress, timeoutMs: cfg.timeoutMs, idleTimeoutMs: cfg.idleTimeoutMs });
      const who = r.agent === "gemini" ? "Gemini" : r.agent === "claude" ? "Claude Code" : "";
      const tail = [r.changes ? `cambios: ${r.changes}` : "", r.verify ? (r.verify.ok ? "comprobación OK" : "la comprobación falla") : ""].filter(Boolean).join(" · ");
      return { ok: r.ok, summary: `${who ? `${who}: ` : ""}${r.summary}${tail ? ` (${tail})` : ""}`, output: r, provenance: "untrusted_external" };
    },
  };
}

/** "en el proyecto X, <tarea>" -> run it directly (no model needed to route it). The task keeps the user's own wording. */
export function codingIntentRule(normalized: string, original: string = normalized): Intent | undefined {
  if (!/^(?:en|dentro de|sobre)\s+(?:el\s+)?proyecto\s+\S+/.test(normalized)) return undefined;
  const m = /^\s*(?:en|dentro de|sobre)\s+(?:el\s+)?proyecto\s+([^\s,:]+)[\s,:]+(.+)$/isu.exec(original.replace(/^\s*(?:oye\s+|hey\s+)?jarvis[\s,.:;!]*/iu, "").trim());
  if (!m?.[1] || !m[2] || m[2].trim().length < 3) return undefined;
  return { route: "local", intent: "code.agent", tool: "code.agent", args: { project: m[1], task: m[2].trim() }, confidence: 1 };
}
