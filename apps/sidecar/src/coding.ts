import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ClaudeCodeAgent, GeminiCliAgent, changesSinceAgent, isInstalled, runCodingTask, undoAgentChanges, type ChangesReport, type CodingAgent, type CodingTaskResult, type Project } from "@jarvis/agents";
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
/** Shared by the coding tools: "deshacé los cambios" without naming a project means the one the agent last worked in. */
export interface CodingSession {
  lastProject?: string;
}

export function makeCodeAgentTool(cfg: Config["coding"], workspace: string, agents: () => CodingAgent[] = () => availableAgents(cfg), session: CodingSession = {}): Tool<{ task: string; project?: string }, CodingTaskResult> {
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
      if (p.name !== "espacio de trabajo") session.lastProject = p.name;
      const r = await runCodingTask({ task, project: p, agents: list, signal: ctx.signal, onProgress: ctx.progress, timeoutMs: cfg.timeoutMs, idleTimeoutMs: cfg.idleTimeoutMs });
      const who = r.agent === "gemini" ? "Gemini" : r.agent === "claude" ? "Claude Code" : "";
      const tail = [r.changes ? `cambios: ${r.changes}` : "", r.verify ? (r.verify.ok ? "comprobación OK" : "la comprobación falla") : "", r.undoable && r.changes !== "sin cambios" ? "se puede deshacer" : ""].filter(Boolean).join(" · ");
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

const projectFor = (cfg: Config["coding"], session: CodingSession, project: string | undefined, workspace: string): Project | { error: string } =>
  resolveProject(cfg, project ?? session.lastProject, workspace);

/** `code.changes`: what the last agent run changed in a project (read-only; file names and a diff stat, no file contents). */
export function makeCodeChangesTool(cfg: Config["coding"], workspace: string, session: CodingSession = {}): Tool<{ project?: string }, ChangesReport> {
  return {
    name: "code.changes",
    description: "List the files the last coding-agent run changed in a project (and whether they changed again afterwards).",
    risk: "read",
    reversible: true,
    input: z.object({ project: z.string().min(1).max(80).optional() }),
    async run({ project }) {
      const p = projectFor(cfg, session, project, workspace);
      if ("error" in p) return { ok: false, summary: p.error, provenance: "system" };
      const c = changesSinceAgent(p.path);
      if (!c.available) return { ok: true, summary: `No hay trabajo de un agente registrado en «${p.name}» (o el proyecto no usa git).`, output: c, provenance: "system" };
      if (c.files.length === 0) return { ok: true, summary: `En «${p.name}» no quedó ningún cambio desde que empezó el agente.`, output: c, provenance: "system" };
      const names = c.files.slice(0, 8).map((f) => `${f.status === "A" ? "nuevo" : f.status === "D" ? "borrado" : "editado"} ${f.path}`);
      const after = c.editedSince.length ? ` Después del agente cambiaron: ${c.editedSince.slice(0, 5).join(", ")}.` : "";
      // File names come from the repository (the agent chose them): untrusted, like the agent's own report.
      return { ok: true, summary: `En «${p.name}», ${c.files.length} archivo(s): ${names.join(", ")}${c.files.length > 8 ? "…" : ""}.${after}`, output: c, provenance: "untrusted_external" };
    },
  };
}

/**
 * `code.undo`: put a project's files back as they were before the last agent run (ADR-0026). Sensitive (it rewrites files), and
 * only for the user's own command: a model cannot undo work on its own.
 */
export function makeCodeUndoTool(cfg: Config["coding"], workspace: string, session: CodingSession = {}): Tool<{ project?: string; force?: boolean }, unknown> {
  return {
    name: "code.undo",
    description: "Undo the last coding-agent run in a project (restore its files as they were before).",
    risk: "sensitive",
    reversible: false,
    modelCallable: false,
    input: z.object({ project: z.string().min(1).max(80).optional(), force: z.boolean().default(false) }),
    async run({ project, force }) {
      const p = projectFor(cfg, session, project, workspace);
      if ("error" in p) return { ok: false, summary: p.error, provenance: "system" };
      try {
        const r = undoAgentChanges(p.path, { force });
        if (!r.ok) return { ok: false, summary: `No deshice nada en «${p.name}»: ${r.reason}.${/no los piso/.test(r.reason) ? " Si querés perder esos cambios también, decí «deshacé los cambios igual»." : ""}`, provenance: "system" };
        return { ok: true, summary: `Listo: «${p.name}» volvió a como estaba antes del agente (${r.restored} archivo(s) restaurado(s), ${r.removed} borrado(s)).`, output: r, provenance: "system" };
      } catch (e) {
        return { ok: false, summary: `No pude deshacer: ${e instanceof Error ? e.message : String(e)}`, provenance: "system" };
      }
    },
  };
}

const PROJECT_TAIL = String.raw`(?:\s+(?:en|del|de|dentro del)\s+(?:el\s+)?proyecto\s+([a-z0-9_.-]+))?`;
const AGENT = String.raw`(?:\s+(?:el\s+)?(?:agente|gemini|claude(?:\s+code)?))`;
const CHANGES = new RegExp(
  String.raw`^(?:(?:muestrame|mostrame|ensename|dime|decime|lista|revisa)\s+)?(?:que|cuales|los)?\s*(?:cambios(?:\s+(?:hizo|hiciste|hay|hubo))?|cambio|cambiaste|archivos\s+(?:cambio|toco|tocaste|modifico|modificaste|cambiaste))(${AGENT})?${PROJECT_TAIL}$`,
);
const UNDO = new RegExp(
  String.raw`^(?:deshaz|deshace|deshacer|desace|deshas|revierte|reverti|revertir|descarta|descartar)\s+(?:(?:todos\s+)?los\s+cambios|lo\s+que\s+hizo|lo\s+ultimo(?:\s+que\s+hizo)?|todo\s+lo\s+que\s+hizo)(${AGENT}|\s+que\s+hizo${AGENT})?${PROJECT_TAIL}(\s+(?:igual|de todas formas|de todos modos))?$`,
);

/** "¿qué cambió el agente en el proyecto X?" / "deshacé los cambios del proyecto X". Generic phrasings need "agente" or "proyecto". */
export function codingControlRule(normalized: string): Intent | undefined {
  const c = CHANGES.exec(normalized);
  if (c && (c[1] || c[2] || /^(?:que|cuales)\s+(?:cambiaste|archivos\s+(?:tocaste|modificaste|cambiaste))$/.test(normalized))) {
    return { route: "local", intent: "code.changes", tool: "code.changes", args: c[2] ? { project: c[2] } : {}, confidence: 1 };
  }
  const u = UNDO.exec(normalized);
  if (u) return { route: "local", intent: "code.undo", tool: "code.undo", args: { ...(u[2] ? { project: u[2] } : {}), ...(u[3] ? { force: true } : {}) }, confidence: 1 };
  return undefined;
}
