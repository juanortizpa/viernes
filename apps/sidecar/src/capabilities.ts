import { z } from "zod";
import type { Intent } from "@jarvis/core";
import type { McpServerStatus } from "@jarvis/mcp";
import type { Tool } from "@jarvis/tools";

/** What is available right now, read live (MCP servers connect after start-up; aliases are learned while running). */
export interface CapabilitySnapshot {
  models: string[];
  offline: boolean;
  apps: number;
  projects: string[];
  codingAgents: string[];
  routines: string[];
  mcp: McpServerStatus[];
  voice: string[];
  memory: boolean;
  web: string[];
}

/** The answer to "¿qué podés hacer?", built from the real configuration: nothing is listed that is not wired up. */
export function describeCapabilities(s: CapabilitySnapshot): string {
  const lines: string[] = [];
  lines.push(s.offline ? "No tengo ningún modelo configurado: solo órdenes locales." : `Responder y razonar con ${s.models.length} modelo(s), el más barato que alcance primero.`);
  lines.push(`Abrir aplicaciones (${s.apps} conocidas): «abre la calculadora».`);
  lines.push("Hora y fecha, recordar lo que me pidas («recuerda que…», «qué recuerdas de mí»).");
  if (s.codingAgents.length) {
    lines.push(`Programar con ${s.codingAgents.join(" → ")}${s.projects.length ? ` en tus proyectos (${s.projects.join(", ")})` : ""}: «en el proyecto X, …»; después «¿qué cambió el agente?» y «deshacé los cambios».`);
  } else lines.push("Programar: falta instalar Gemini CLI o Claude Code.");
  if (s.routines.length) lines.push(`Rutinas: ${s.routines.map((r) => `«${r}»`).join(", ")}.`);
  else lines.push("Rutinas: ninguna todavía (routines en jarvis.config.json).");
  if (s.web.length) lines.push(`Web: ${s.web.join(" y ")}.`);
  const up = s.mcp.filter((m) => m.ok);
  const down = s.mcp.filter((m) => !m.ok);
  if (up.length) lines.push(`Herramientas MCP: ${up.map((m) => `${m.name} (${m.tools.length})`).join(", ")}.`);
  if (down.length) lines.push(`Servidores MCP sin conectar: ${down.map((m) => `${m.name} (${m.error ?? "error"})`).join(", ")}.`);
  if (s.voice.length) lines.push(`Voz: ${s.voice.join(", ")}.`);
  if (!s.memory) lines.push("La memoria de largo plazo está apagada.");
  return lines.map((l) => `• ${l}`).join("\n");
}

export function makeCapabilitiesTool(snapshot: () => CapabilitySnapshot): Tool<Record<string, never>, CapabilitySnapshot> {
  return {
    name: "assistant.capabilities",
    description: "What this assistant can do right now on this computer (apps, projects, coding agents, routines, MCP tools, web, voice).",
    risk: "read",
    reversible: true,
    input: z.object({}).strict(),
    async run() {
      const s = snapshot();
      return { ok: true, summary: describeCapabilities(s), output: s, provenance: "system" };
    },
  };
}

/** A routine whose steps cannot all run locally: say why instead of running half of it. */
export const routineInvalidTool: Tool<{ name: string; problems: string[] }, void> = {
  name: "routine.invalid",
  description: "Report why a configured routine cannot run",
  risk: "read",
  reversible: true,
  modelCallable: false,
  input: z.object({ name: z.string(), problems: z.array(z.string()) }),
  async run({ name, problems }) {
    return { ok: false, summary: `No ejecuto la rutina «${name}»: ${problems.join("; ")}. Corregila en jarvis.config.json.`, provenance: "system" };
  },
};

const HELP = /^(?:ayuda|help|que (?:puedes|podes|sabes|sabe) hacer|que (?:cosas )?(?:puedes|podes) hacer(?: por mi)?|que haces|que herramientas (?:tienes|tenes|hay)|que comandos (?:hay|tienes|tenes|entiendes|entendes)|que rutinas (?:tengo|hay|tenes|tienes)|que servidores mcp (?:hay|tengo|tienes|tenes))$/;

export function capabilitiesRule(normalized: string): Intent | undefined {
  return HELP.test(normalized) ? { route: "local", intent: "assistant.capabilities", tool: "assistant.capabilities", args: {}, confidence: 1 } : undefined;
}
