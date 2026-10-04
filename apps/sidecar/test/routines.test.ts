import { describe, expect, it } from "vitest";
import { EventBus } from "@jarvis/core";
import type { OrchestratorEvent } from "@jarvis/protocol";
import { Config } from "../src/config";
import { buildRuntime } from "../src/runtime";
import { capabilitiesRule, describeCapabilities } from "../src/capabilities";

const run = async (cfg: Config, input: string, opts: { grant?: boolean; launched?: string[] } = {}) => {
  const events: OrchestratorEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  const asked: string[] = [];
  const r = buildRuntime(cfg, { env: {}, launcher: async (c) => void opts.launched?.push(c), codingAgents: () => [] });
  const trace = await r.createOrchestrator({ bus, askPermission: async (q) => (asked.push(q.tool), opts.grant ?? true) }).run(input);
  const summary = (events.find((e) => e.type === "task.finished") as { summary?: string }).summary;
  return { r, trace, events, asked, summary };
};

describe("routines (ADR-0027)", () => {
  const cfg = Config.parse({
    apps: { "vs code": "code", teams: "teams", calculadora: "calc" },
    routines: { "modo trabajo": ["abre vs code", "abre teams", "qué hora es"], "mal armada": ["abre vs code", "escribime un poema"] },
  });

  it("runs every step in order by its name or 'activá la rutina …', without any model", async () => {
    for (const phrase of ["Modo trabajo", "activá la rutina modo trabajo", "jarvis, ejecuta modo trabajo"]) {
      const launched: string[] = [];
      const { trace, events, summary } = await run(cfg, phrase, { launched });
      expect(launched).toEqual(["code", "teams"]);
      expect(trace.attempts).toEqual([]); // no model call
      expect(trace.finalOutcome).toBe("success");
      expect(summary).toBe("Rutina «modo trabajo» lista (3 pasos).");
      expect(events.filter((e) => e.type === "progress").map((e) => (e as { stage: string }).stage)).toEqual([
        "Rutina «modo trabajo»: paso 1 de 3",
        "Rutina «modo trabajo»: paso 2 de 3",
        "Rutina «modo trabajo»: paso 3 de 3",
      ]);
    }
  });

  it("refuses a routine with a step that would need a model, and says so at start-up", async () => {
    const launched: string[] = [];
    const { r, summary, trace } = await run(cfg, "mal armada", { launched });
    expect(launched).toEqual([]); // not half of it
    expect(trace.finalOutcome).toBe("failure");
    expect(summary).toMatch(/No ejecuto la rutina «mal armada»: «escribime un poema» no es una orden/);
    expect(r.warnings).toEqual(["rutina «mal armada»: «escribime un poema» no es una orden que entienda sin un modelo"]);
  });

  it("each sensitive step asks; a denied step is reported and the others still run", async () => {
    const c = Config.parse({ apps: { teams: "teams" }, routines: { limpieza: ["olvida esta conversación", "abre teams", "deshacé los cambios del proyecto web"] }, coding: { projects: {} } });
    const launched: string[] = [];
    const { asked, summary, trace } = await run(c, "limpieza", { grant: false, launched });
    expect(asked).toEqual(["code.undo"]);
    expect(launched).toEqual(["teams"]);
    expect(trace.finalOutcome).toBe("failure");
    expect(summary).toMatch(/2 de 3 pasos\. No salió: «deshacé los cambios del proyecto web» \(permission denied by user\)/);
  });

  it("a routine name does not swallow other commands", async () => {
    const launched: string[] = [];
    await run(cfg, "abre la calculadora", { launched });
    expect(launched).toEqual(["calc"]);
  });
});

describe("¿qué podés hacer?", () => {
  it("is answered locally from what is really configured", async () => {
    expect(capabilitiesRule("que podes hacer")).toMatchObject({ tool: "assistant.capabilities" });
    expect(capabilitiesRule("que puedes hacer por mi")).toBeDefined();
    expect(capabilitiesRule("que puedes hacer con python")).toBeUndefined();
    const c = Config.parse({ routines: { "modo trabajo": ["abre vs code"] }, coding: { projects: {} } });
    const { summary, trace } = await run(c, "¿Qué podés hacer?");
    expect(trace.attempts).toEqual([]);
    expect(summary).toMatch(/No tengo ningún modelo configurado/);
    expect(summary).toMatch(/Rutinas: «modo trabajo»/);
    expect(summary).toMatch(/falta instalar Gemini CLI o Claude Code/);
  });

  it("lists MCP servers, including the ones that failed and why", () => {
    const text = describeCapabilities({ models: ["m"], offline: false, apps: 3, projects: ["web"], codingAgents: ["Gemini CLI"], routines: [], mcp: [{ name: "github", ok: true, tools: ["a", "b"] }, { name: "fs", ok: false, tools: [], error: "timeout" }], voice: [], memory: true, web: [] });
    expect(text).toMatch(/Herramientas MCP: github \(2\)/);
    expect(text).toMatch(/sin conectar: fs \(timeout\)/);
    expect(text).toMatch(/Gemini CLI en tus proyectos \(web\)/);
  });
});
