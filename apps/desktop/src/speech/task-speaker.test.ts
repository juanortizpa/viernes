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

describe("TaskSpeaker: speaking while the model writes (ADR-0029)", () => {
  const llm = { type: "intent.resolved", route: "llm", confidence: 1 };
  it("says the first sentence as soon as it is complete, not when the answer ends", () => {
    const { said, feed } = setup();
    feed(started("qué es un closure"), llm, { type: "response.delta", text: "Un closure es una función" });
    expect(said).toEqual(["<cancel>"]);
    feed({ type: "response.delta", text: " que recuerda su entorno. Se usa mucho en" });
    expect(said.at(-1)).toBe("es:Un closure es una función que recuerda su entorno.");
    feed({ type: "response.delta", text: " JavaScript." }, { type: "task.finished", outcome: "success" });
    expect(said.at(-1)).toBe("es:Se usa mucho en JavaScript.");
    expect(said).toHaveLength(3);
  });

  it("never splits a number or a code block, never reads code, and keeps to the spoken budget", () => {
    const { said, feed } = setup();
    feed(started("dólar"), llm, { type: "response.delta", text: "El blue está a $1.560 hoy. " });
    expect(said.at(-1)).toBe("es:El blue está a $1.560 hoy.");
    feed({ type: "response.delta", text: "Mirá:\n```js\nconst a = 1. b = 2.\n" });
    expect(said).toHaveLength(2); // nothing from inside the open fence
    feed({ type: "response.delta", text: "```\nUno. Dos. Tres. Cuatro." }, { type: "task.finished", outcome: "success" });
    expect(said.join("|")).not.toMatch(/const a/);
    expect(said.filter((s) => /Uno|Dos|Tres|Cuatro/.test(s)).join(" ")).not.toMatch(/Tres|Cuatro/); // 3 sentences at most
    expect(said.at(-1)).toBe("es:Te dejé el detalle en pantalla.");
  });

  it("if part of a failed attempt was already said, the corrected answer says so", () => {
    const { said, feed } = setup();
    feed(started("x"), llm, { type: "response.delta", text: "No sé. " }, { type: "escalated", from: "a", to: "b", reason: "x" }, { type: "response.delta", text: "Es así. " }, { type: "task.finished", outcome: "success" });
    expect(said.slice(1)).toEqual(["es:No sé.", "es:Mejor dicho: Es así."]);
  });

  it("narrates real progress of long tasks, rarely and only after a while", () => {
    let t = 0;
    const said: string[] = [];
    const ts = new TaskSpeaker({ speak: (x) => said.push(x), cancel: () => {} }, () => "voice", () => t);
    const f = (b: Body) => ts.onEvent(ev(b));
    f(started("en el proyecto web, arreglá el login"));
    f({ type: "intent.resolved", route: "local", intent: "code.agent", confidence: 1 });
    t = 2_000;
    f({ type: "progress", stage: "Gemini: Leyendo login.js" });
    expect(said).toEqual([]); // too early
    t = 11_000;
    f({ type: "progress", stage: "Gemini: Editando login.js" });
    expect(said).toEqual(["Editando login.js."]);
    t = 15_000;
    f({ type: "progress", stage: "Comprobando con «pnpm test»" });
    expect(said).toHaveLength(1); // not again so soon
    t = 26_000;
    f({ type: "progress", stage: "Comprobando con «pnpm test»" });
    expect(said.at(-1)).toBe("Comprobando con pnpm test.");
  });
});
