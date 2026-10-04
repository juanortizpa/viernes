import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type OrchestratorEvent } from "@jarvis/core";
import type { AgentRunOptions, CodingAgent } from "@jarvis/agents";
import { Config } from "../src/config";
import { availableAgents, codingIntentRule, makeCodeAgentTool, resolveProject } from "../src/coding";
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
