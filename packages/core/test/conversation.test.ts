import { describe, expect, it } from "vitest";
import { ConversationMemory, IntentRouter, conversationControlRules } from "../src";

const mk = (over: ConstructorParameters<typeof ConversationMemory>[0] = {}, t = { now: 1_000 }) => ({ t, c: new ConversationMemory({ now: () => t.now, ...over }) });

describe("ConversationMemory", () => {
  it("replays earlier exchanges as alternating chat messages, oldest first", () => {
    const { c } = mk();
    c.record("quién ganó el mundial", "¿Masculino o femenino?");
    c.record("masculino", "Argentina (2022).");
    expect(c.messages()).toEqual([
      { role: "user", content: "quién ganó el mundial" },
      { role: "assistant", content: "¿Masculino o femenino?" },
      { role: "user", content: "masculino" },
      { role: "assistant", content: "Argentina (2022)." },
    ]);
    expect(c.size()).toBe(2);
  });

  it("keeps within the turn and character budgets, dropping the oldest first but never the newest", () => {
    const { c } = mk({ maxTurns: 3 });
    for (let i = 1; i <= 5; i++) c.record(`pregunta ${i}`, `respuesta ${i}`);
    expect(c.size()).toBe(3);
    expect(c.messages()[0]).toEqual({ role: "user", content: "pregunta 3" });

    const small = mk({ maxChars: 60 }).c;
    small.record("a".repeat(50), "b".repeat(50)); // alone it is over budget, but it is the newest: kept
    expect(small.size()).toBe(1);
    small.record("c", "d");
    expect(small.messages().map((m) => m.content)).toEqual(["c", "d"]); // now the old one does not fit
  });

  it("forgets after the idle period", () => {
    const { c, t } = mk({ idleMs: 60_000 });
    c.record("hola", "¿en qué te ayudo?");
    t.now += 59_000;
    expect(c.size()).toBe(1);
    t.now += 2_000;
    expect(c.size()).toBe(0);
    expect(c.messages()).toEqual([]);
  });

  it("recognises a follow-up: the assistant just asked something, or the reply is very short", () => {
    const { c } = mk();
    expect(c.isFollowUp("masculino")).toBe(false); // nothing to follow
    c.record("quién ganó el mundial", "¿Masculino o femenino?");
    expect(c.isFollowUp("el masculino de fútbol del año pasado")).toBe(true); // it asked a question
    c.record("qué es un closure", "Una función que recuerda el entorno donde fue creada.");
    for (const t of ["y en python?", "otro", "con ejemplos", "explícame eso mejor", "pero por qué funciona así", "what about python"]) expect(c.isFollowUp(t), t).toBe(true);
    // Complete questions are standalone even when they are short: they must not inherit the previous question.
    for (const t of ["explícame cómo funciona la recursión con un ejemplo", "¿Quién ganó el mundial?", "qué hora es en Tokio", "capital de Francia"]) expect(c.isFollowUp(t), t).toBe(false);
  });

  it("classifies a follow-up together with the question it answers", () => {
    const { c } = mk();
    c.record("explica la diferencia entre TCP y UDP", "¿Con ejemplos o solo la teoría?");
    expect(c.routingText("con ejemplos")).toBe("explica la diferencia entre TCP y UDP con ejemplos");
    c.record("x", "una respuesta sin pregunta"); // last answer asks nothing
    expect(c.routingText("explícame la historia completa de la computación moderna")).toBe("explícame la historia completa de la computación moderna");
  });

  it("never keeps a secret, on either side of the exchange", () => {
    const { c } = mk();
    expect(c.record("mi contraseña es hunter2hunter2", "ok")).toBe(false);
    expect(c.record("cuál es la clave", "tu password es correcthorse99")).toBe(false);
    expect(c.size()).toBe(0);
  });

  it("can be switched off (and then forgets) or cleared on demand", () => {
    const { c } = mk();
    c.record("a", "b");
    expect(c.clear()).toBe(1);
    expect(c.clear()).toBe(0);
    c.record("a", "b");
    c.setEnabled(false);
    expect(c.size()).toBe(0);
    expect(c.record("c", "d")).toBe(false);
    c.setEnabled(true);
    expect(c.size()).toBe(0);
  });
});

describe("conversation commands", () => {
  const r = new IntentRouter({ apps: {}, rules: conversationControlRules });
  it("maps 'forget this conversation' in Spanish and English, and nothing else", () => {
    for (const t of ["olvida esta conversación", "borra la conversación", "nueva conversación", "empecemos de nuevo", "forget this conversation", "start over"])
      expect(r.resolve(t), t).toMatchObject({ route: "local", tool: "conversation.clear" });
    for (const t of ["olvida el alias paint", "cuéntame de la conversación de ayer", "qué es una conversación"]) expect(r.resolve(t).route, t).not.toBe("conversation.clear");
  });
});
