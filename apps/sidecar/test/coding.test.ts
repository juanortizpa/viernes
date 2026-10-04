import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@jarvis/core";
import type { OrchestratorEvent } from "@jarvis/protocol";
import type { AgentRunOptions, CodingAgent } from "@jarvis/agents";
import { Config } from "../src/config";
import { availableAgents, codingControlRule, codingIntentRule, makeCodeAgentTool, makeCodeChangesTool, makeCodeUndoTool, resolveProject } from "../src/coding";
import { buildRuntime } from "../src/runtime";

const noop = async () => {};
const dir = () => mkdtempSync(join(tmpdir(), "jarvis-code-"));

function fakeAgent(name: string, behave: (o: AgentRunOptions) => Promise<{ ok: boolean; summary: string; limited?: boolean }>, calls: string[] = []): CodingAgent {
  return {
    name,
    async run(o) {
      calls.push(name);
      o.onProgress?.("Editando app.js");
      const r = await behave(o);
      return { ...r, stoppedBy: "exit", touched: [] };
    },
  };
}

describe("coding config and projects", () => {
  it("keeps only installed agents, cheapest first", () => {
    const cfg = Config.parse({}).coding;
    expect(cfg.agents).toEqual(["gemini", "claude"]);
    expect(availableAgents(cfg, () => true).map((a) => a.name)).toEqual(["gemini", "claude"]);
    expect(availableAgents(cfg, (b) => b === "claude").map((a) => a.name)).toEqual(["claude"]);
    expect(availableAgents(cfg, () => false)).toEqual([]);
  });

  it("resolves aliases ignoring accents and case, and refuses unknown names or missing folders", () => {
    const p = dir();
    const cfg = Config.parse({ coding: { projects: { Jarvís: { path: p, verify: "pnpm test" }, viejo: { path: join(p, "no-existe") } } } }).coding;
    expect(resolveProject(cfg, "jarvis", "/w")).toEqual({ name: "Jarvís", path: p, verify: "pnpm test" });
    expect(resolveProject(cfg, "otro", "/w")).toMatchObject({ error: expect.stringMatching(/No conozco.*Jarvís, viejo/) });
    expect(resolveProject(cfg, "viejo", "/w")).toMatchObject({ error: expect.stringMatching(/no existe/) });
    const ws = join(p, "ws");
    expect(resolveProject(cfg, undefined, ws)).toEqual({ name: "espacio de trabajo", path: ws });
  });
});

describe("codingIntentRule", () => {
  it("routes 'en el proyecto X, …' directly and keeps the user's own wording", () => {
    const original = "Jarvis, en el proyecto Web: arreglá el botón de «Guardar»";
    expect(codingIntentRule("en el proyecto web arregla el boton de guardar", original)).toEqual({
      route: "local",
      intent: "code.agent",
      tool: "code.agent",
      args: { project: "Web", task: "arreglá el botón de «Guardar»" },
      confidence: 1,
    });
    expect(codingIntentRule("abre el proyecto")).toBeUndefined();
    expect(codingIntentRule("en el proyecto web", "en el proyecto web")).toBeUndefined();
  });
});

describe("code.agent tool", () => {
  it("escalates on failure, reports progress and marks its output untrusted", async () => {
    const p = dir();
    writeFileSync(join(p, "a.txt"), "x");
    const cfg = Config.parse({ coding: { projects: { demo: { path: p } } } }).coding;
    const calls: string[] = [];
    const stages: string[] = [];
    const tool = makeCodeAgentTool(cfg, p, () => [
      fakeAgent("gemini", async () => ({ ok: false, summary: "cuota agotada", limited: true }), calls),
      fakeAgent("claude", async () => ({ ok: true, summary: "Listo, corregí el bug." }), calls),
    ]);
    expect(tool.risk).toBe("sensitive");
    const r = await tool.run({ task: "arregla el bug", project: "demo" }, { taskId: "t", progress: (s) => stages.push(s) });
    expect(calls).toEqual(["gemini", "claude"]);
    expect(r).toMatchObject({ ok: true, provenance: "untrusted_external", summary: expect.stringMatching(/^Claude Code: Listo/) });
    expect(stages).toEqual(expect.arrayContaining(["Gemini: empezando", "Claude Code: Editando app.js"]));
  });

  it("refuses unknown projects and explains how to install an agent when none is present", async () => {
    const cfg = Config.parse({}).coding;
    const tool = makeCodeAgentTool(cfg, dir(), () => []);
    expect(await tool.run({ task: "hacé algo", project: "nada" }, { taskId: "t" })).toMatchObject({ ok: false, summary: expect.stringMatching(/No conozco/) });
    expect(await tool.run({ task: "hacé algo" }, { taskId: "t" })).toMatchObject({ ok: false, summary: expect.stringMatching(/npm i -g @google\/gemini-cli/) });
  });

  it("passes the cancellation signal through to the agent", async () => {
    const ctl = new AbortController();
    let seen: AbortSignal | undefined;
    const tool = makeCodeAgentTool(Config.parse({}).coding, dir(), () => [
      fakeAgent("gemini", async (o) => {
        seen = o.signal;
        ctl.abort();
        return { ok: false, summary: "cancelado" };
      }),
    ]);
    await tool.run({ task: "tarea larga" }, { taskId: "t", signal: ctl.signal });
    expect(seen?.aborted).toBe(true);
  });
});

describe("code.agent in the runtime", () => {
  it("asks permission before touching code and streams the agent's real stages as progress", async () => {
    const p = dir();
    const events: OrchestratorEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const cfg = Config.parse({ coding: { projects: { demo: { path: p } } } });
    const r = buildRuntime(cfg, { env: {}, launcher: noop, workspace: p, codingAgents: () => [fakeAgent("gemini", async () => ({ ok: true, summary: "Hecho." }))] });
    let asked = 0;
    await r.createOrchestrator({ bus, askPermission: async () => (asked++, true) }).run("en el proyecto demo, agrega un README");
    expect(asked).toBe(1);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["permission.required", "progress", "tool.completed"]));
    expect(events.find((e) => e.type === "progress" && /Editando app.js/.test(e.stage))).toBeDefined();
  });

  it("does nothing when permission is denied", async () => {
    const p = dir();
    const calls: string[] = [];
    const cfg = Config.parse({ coding: { projects: { demo: { path: p } } } });
    const r = buildRuntime(cfg, { env: {}, launcher: noop, workspace: p, codingAgents: () => [fakeAgent("gemini", async () => ({ ok: true, summary: "Hecho." }), calls)] });
    await r.createOrchestrator({ bus: new EventBus(), askPermission: async () => false }).run("en el proyecto demo, borra todo");
    expect(calls).toEqual([]);
  });
});

describe("undo and changes of agent work (ADR-0026)", () => {
  const sh = (cwd: string, ...args: string[]): void => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  function gitProject(): string {
    const p = dir();
    sh(p, "init", "-q");
    writeFileSync(join(p, "app.js"), "v1\n");
    sh(p, "add", ".");
    sh(p, "commit", "-qm", "init");
    return p;
  }

  it("understands the spoken commands and only claims generic phrasings when they name the agent or a project", () => {
    expect(codingControlRule("que cambio el agente en el proyecto web")).toMatchObject({ tool: "code.changes", args: { project: "web" } });
    expect(codingControlRule("muestrame los cambios del proyecto jarvis")).toMatchObject({ tool: "code.changes", args: { project: "jarvis" } });
    expect(codingControlRule("que cambiaste")).toMatchObject({ tool: "code.changes", args: {} });
    expect(codingControlRule("que cambio")).toBeUndefined(); // "¿qué cambió?" alone could be about anything
    expect(codingControlRule("que cambios hubo en la economia")).toBeUndefined();
    expect(codingControlRule("deshace los cambios")).toMatchObject({ tool: "code.undo", args: {} });
    expect(codingControlRule("deshaz lo que hizo el agente en el proyecto web")).toMatchObject({ tool: "code.undo", args: { project: "web" } });
    expect(codingControlRule("revierte los cambios del proyecto web igual")).toMatchObject({ tool: "code.undo", args: { project: "web", force: true } });
    expect(codingControlRule("deshaz el nudo de la corbata")).toBeUndefined();
  });

  it("agent edits → '¿qué cambió el agente?' → 'deshacé los cambios' (asks first) → files restored", async () => {
    const p = gitProject();
    const events: OrchestratorEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const cfg = Config.parse({ coding: { projects: { web: { path: p } } } });
    const agent = fakeAgent("gemini", async (o) => {
      writeFileSync(join(o.cwd, "app.js"), "broken by agent\n");
      writeFileSync(join(o.cwd, "extra.js"), "new\n");
      return { ok: true, summary: "Hecho." };
    });
    const r = buildRuntime(cfg, { env: {}, launcher: noop, workspace: p, codingAgents: () => [agent] });
    const asked: string[] = [];
    const orch = r.createOrchestrator({ bus, askPermission: async (req) => (asked.push(req.tool), true) });
    await orch.run("en el proyecto web, refactoriza app.js");
    const done = (): string | undefined => (events.filter((e) => e.type === "task.finished").at(-1) as { summary?: string } | undefined)?.summary;
    expect(done()).toMatch(/se puede deshacer/);

    await orch.run("¿qué cambió el agente?"); // no project named: the one it last worked in
    expect(done()).toMatch(/2 archivo\(s\): editado app\.js, nuevo extra\.js/);

    await orch.run("Deshacé los cambios");
    expect(asked).toEqual(["code.agent", "code.undo"]);
    expect(done()).toMatch(/volvió a como estaba/);
    expect(readFileSync(join(p, "app.js"), "utf8")).toBe("v1\n");
    expect(existsSync(join(p, "extra.js"))).toBe(false);
  });

  it("the model can read changes but can never undo on its own", () => {
    const cfg = Config.parse({}).coding;
    expect(makeCodeUndoTool(cfg, dir()).modelCallable).toBe(false);
    expect(makeCodeChangesTool(cfg, dir()).risk).toBe("read");
  });
});
