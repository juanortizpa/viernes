import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "@jarvis/protocol";
import type { SpeakMode } from "./policy";
import { TaskSpeaker } from "./task-speaker";

let n = 0;
type Body = Record<string, unknown> & { type: string };
const ev = (b: Body) => ({ id: `e${n}`, taskId: "t", seq: n++, ts: n, ...b }) as unknown as OrchestratorEvent;

function setup(mode: SpeakMode = "voice") {
  const said: string[] = [];
  const speaker = { speak: (t: string, l: string) => said.push(`${l}:${t}`), cancel: () => said.push("<cancel>") };
  const ts = new TaskSpeaker(speaker, () => mode);
  const feed = (...bs: Body[]) => bs.forEach((b) => ts.onEvent(ev(b)));
  return { said, feed };
}
const started = (input: string, modality = "voice") => ({ type: "task.started", input, modality });

describe("TaskSpeaker", () => {
  it("says the acknowledgement immediately, then the model's answer without markup", () => {
    const { said, feed } = setup();
    feed(started("crea un proyecto"), { type: "intent.resolved", route: "llm", confidence: 1 }, { type: "instant.issued", kind: "ack", text: "Entendido, me pongo con eso." });
    expect(said).toEqual(["<cancel>", "es:Entendido, me pongo con eso."]);
    feed({ type: "response.delta", text: "**Listo**, " }, { type: "response.delta", text: "creé el proyecto." }, { type: "task.finished", outcome: "success" });
    expect(said.at(-1)).toBe("es:Listo, creé el proyecto.");
  });

  it("speaks only the final attempt after an escalation", () => {
    const { said, feed } = setup();
    feed(started("explica qué es un closure"), { type: "response.delta", text: "respuesta mala" }, { type: "escalated", from: "a", to: "b", reason: "x" }, { type: "response.delta", text: "Un closure es una función con su entorno." }, { type: "task.finished", outcome: "success" });
    expect(said.at(-1)).toBe("es:Un closure es una función con su entorno.");
    expect(said.join()).not.toMatch(/mala/);
  });

  it("confirms local actions in plain words, not with the English tool summary", () => {
    const { said, feed } = setup();
    feed(started("abre la calculadora"), { type: "intent.resolved", route: "local", intent: "apps.open", confidence: 1 }, { type: "tool.completed", tool: "apps.open", ok: true, summary: "opened calc" }, { type: "task.finished", outcome: "success", summary: "opened calc" });
    expect(said.at(-1)).toBe("es:Listo.");
    expect(said.join()).not.toMatch(/opened/);
    feed(started("qué hora es"), { type: "intent.resolved", route: "local", intent: "time.now", confidence: 1 }, { type: "tool.completed", tool: "time.now", ok: true, summary: "domingo, 4 de octubre de 2026, 3:02" }, { type: "task.finished", outcome: "success" });
    expect(said.at(-1)).toMatch(/domingo/);
    feed(started("abre algo"), { type: "intent.resolved", route: "local", intent: "apps.open", confidence: 1 }, { type: "tool.completed", tool: "apps.open", ok: false, summary: "cannot open x" }, { type: "task.finished", outcome: "failure" });
    expect(said.at(-1)).toBe("es:No pude completarlo.");
  });

  it("does not repeat an instant reply at task end, and answers in English to English", () => {
    const { said, feed } = setup();
    feed(started("hello"), { type: "intent.resolved", route: "local", intent: "instant.reply", confidence: 1 }, { type: "instant.issued", kind: "reply", text: "Hi! How can I help?" }, { type: "task.finished", outcome: "success", summary: "Hi! How can I help?" });
    expect(said.filter((s) => s.startsWith("en:"))).toEqual(["en:Hi! How can I help?"]);
  });

  it("respects the mode: voice-only stays silent for typed tasks, never is always silent, always speaks both", () => {
    const run = (mode: SpeakMode, modality: string) => {
      const { said, feed } = setup(mode);
      feed(started("hola", modality), { type: "instant.issued", kind: "reply", text: "¡Hola!" }, { type: "task.finished", outcome: "success" });
      return said.filter((s) => s !== "<cancel>");
    };
    expect(run("voice", "text")).toEqual([]);
    expect(run("voice", "voice")).toEqual(["es:¡Hola!"]);
    expect(run("never", "voice")).toEqual([]);
    expect(run("always", "text")).toEqual(["es:¡Hola!"]);
  });

  it("asks for permission out loud, says nothing on cancel, and a new task interrupts speech", () => {
    const { said, feed } = setup();
    feed(started("escribe un archivo"), { type: "permission.required", requestId: "r", tool: "files.write", risk: "sensitive", reason: "x" });
    expect(said.at(-1)).toBe("es:Necesito tu permiso.");
    const before = said.length;
    feed({ type: "task.finished", outcome: "cancelled" });
    expect(said).toHaveLength(before);
    feed(started("otra cosa"));
    expect(said.at(-1)).toBe("<cancel>");
  });
});
