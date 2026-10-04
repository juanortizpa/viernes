import { describe, expect, it } from "vitest";
import { IntentRouter, MemoryBook, MemoryMemoryStore, inferKind, memoryControlRules, memoryPrompt, memoryTokens } from "../src";

const mk = (over: ConstructorParameters<typeof MemoryBook>[0] = {}) => new MemoryBook({ store: new MemoryMemoryStore(), ...over });

describe("MemoryBook.add", () => {
  it("saves a fact, infers preferences, and treats a rewording as a duplicate", () => {
    const m = mk();
    const a = m.add("Mi hermana se llama Ana");
    expect(a).toMatchObject({ ok: true, duplicate: false, item: { kind: "fact", text: "Mi hermana se llama Ana" } });
    expect(m.add("prefiero respuestas cortas")).toMatchObject({ ok: true, item: { kind: "preference" } });
    expect(m.add("mi hermana se llama ana")).toMatchObject({ ok: true, duplicate: true });
    expect(m.list()).toHaveLength(2);
  });

  it("refuses secrets, empty and oversized text, and a full book — with a reason the user can read", () => {
    const m = mk({ maxItems: 2 });
    expect(m.add("mi contraseña es hunter2hunter2")).toMatchObject({ ok: false, reason: "sensitive" });
    expect(m.add("mi tarjeta es 4111 1111 1111 1111")).toMatchObject({ ok: false, reason: "sensitive" });
    expect(m.add("   ")).toMatchObject({ ok: false, reason: "empty" });
    expect(m.add("x".repeat(400) + " hermana")).toMatchObject({ ok: false, reason: "too_long" });
    m.add("vivo en Bogotá");
    m.add("trabajo en una startup de logística");
    expect(m.add("tengo un perro labrador")).toMatchObject({ ok: false, reason: "full" });
    expect(m.list()).toHaveLength(2);
  });

  it("does nothing while disabled, and the switch persists in the store", () => {
    const store = new MemoryMemoryStore();
    const m = new MemoryBook({ store });
    m.setEnabled(false);
    expect(m.add("vivo en Bogotá")).toMatchObject({ ok: false, reason: "disabled" });
    expect(new MemoryBook({ store }).enabled).toBe(false);
    expect(m.retrieve("dónde vivo")).toEqual({ preferences: [], facts: [] });
  });
});

describe("MemoryBook.retrieve", () => {
  const book = () => {
    const m = mk();
    for (const t of ["Mi hermana se llama Ana y le encanta el té verde", "Vivo en Bogotá desde 2019", "Mi gato se llama Pelusa", "Trabajo como ingeniero de datos", "prefiero respuestas cortas y directas", "siempre tutéame"]) m.add(t);
    return m;
  };

  it("brings the relevant fact, not the unrelated ones", () => {
    const m = book();
    expect(m.retrieve("cómo se llama mi gato").facts.map((f) => f.item.text)).toEqual(["Mi gato se llama Pelusa"]);
    expect(m.retrieve("recomiéndame un regalo para mi hermana").facts.map((f) => f.item.text)).toEqual(["Mi hermana se llama Ana y le encanta el té verde"]);
    expect(m.retrieve("qué clima suele hacer donde vivo en Bogotá").facts[0]?.item.text).toBe("Vivo en Bogotá desde 2019");
  });

  it("auxiliary verbs are not topics: 'para qué estoy entrenando' must not pull 'estoy construyendo un asistente'", () => {
    const m = mk();
    m.add("Estoy construyendo un asistente personal llamado JARVIS como tesis");
    m.add("I'm training for a half marathon in October");
    expect(m.retrieve("¿Para qué estoy entrenando?").facts).toEqual([]); // measured with a real model: the wrong memory made it invent an answer
  });

  it("injects nothing for questions that have nothing to do with the user", () => {
    const m = book();
    for (const q of ["cuál es la capital de Francia", "explícame qué es un closure en javascript", "qué hora es", "what is the speed of light"])
      expect(m.retrieve(q).facts, q).toEqual([]);
  });

  it("always returns standing preferences, newest first, within their budget", () => {
    const m = book();
    expect(m.retrieve("cualquier cosa").preferences.map((p) => p.text)).toEqual(["siempre tutéame", "prefiero respuestas cortas y directas"]);
    const tiny = mk({ preferenceBudgetChars: 20 });
    tiny.add("prefiero respuestas cortas y directas");
    tiny.add("siempre tutéame");
    expect(tiny.retrieve("x").preferences.map((p) => p.text)).toEqual(["siempre tutéame"]);
  });

  it("respects the fact count and size budgets, and records which items were used", () => {
    const m = mk({ maxFacts: 2, factBudgetChars: 1_000, minScore: 0.3 });
    for (const t of ["mi hermana Ana vive en Cali", "mi hermana Laura vive en Lima", "mi hermana Eva vive en Quito"]) m.add(t);
    const got = m.retrieve("dónde vive mi hermana");
    expect(got.facts).toHaveLength(2);
    m.markUsed(got.facts.map((f) => f.item.id));
    expect(m.list().filter((i) => i.uses === 1)).toHaveLength(2);
    expect(m.list().find((i) => i.uses === 1)?.usedAt).toBeTypeOf("number");
  });
});

describe("MemoryBook.forget / clear", () => {
  it("forgets the one item that matches the description, by text or id", () => {
    const m = mk();
    m.add("Mi hermana se llama Ana");
    m.add("Mi gato se llama Pelusa");
    expect(m.forget("mi hermana se llama ana")).toMatchObject({ ok: true, removed: [{ text: "Mi hermana se llama Ana" }] });
    const gato = m.list()[0]!;
    expect(m.forget(gato.id)).toMatchObject({ ok: true });
    expect(m.list()).toEqual([]);
  });

  it("erases nothing when the description fits several items equally, and says which", () => {
    const m = mk();
    m.add("Mi hermana Ana vive en Cali");
    m.add("Mi hermana Laura vive en Lima");
    const r = m.forget("mi hermana vive");
    expect(r).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(r.ok ? [] : r.candidates).toHaveLength(2);
    expect(m.list()).toHaveLength(2);
    expect(m.forget("la capital de Francia")).toMatchObject({ ok: false, reason: "none" });
  });

  it("clear reports how many items it removed", () => {
    const m = mk();
    m.add("vivo en Bogotá");
    m.add("tengo un perro");
    expect(m.clear()).toBe(2);
    expect(m.list()).toEqual([]);
  });
});

describe("text helpers", () => {
  it("folds plurals and ignores filler words", () => {
    expect(memoryTokens("Mis hermanas se llaman Ana y Eva")).toEqual(["hermana", "llaman", "ana", "eva"]);
  });
  it("tells preferences from facts", () => {
    for (const t of ["prefiero el modo oscuro", "Siempre respóndeme en inglés", "no me gustan las respuestas largas", "I prefer short answers"]) expect(inferKind(t), t).toBe("preference");
    for (const t of ["mi hermana se llama Ana", "vivo en Bogotá"]) expect(inferKind(t), t).toBe("fact");
  });
  it("labels memories as user-provided data in the prompt", () => {
    const p = memoryPrompt([{ id: "1", kind: "preference", text: "siempre tutéame", createdAt: 0, uses: 0 }], [{ id: "2", kind: "fact", text: "vivo en Bogotá", createdAt: 0, uses: 0 }]);
    expect(p).toContain("Standing preferences");
    expect(p).toContain("- siempre tutéame");
    expect(p).toContain("may be relevant");
    expect(memoryPrompt([], [])).toBe("");
  });
});

describe("memory commands", () => {
  const r = new IntentRouter({ apps: { paint: "mspaint" }, rules: memoryControlRules });
  it("saves what was asked with the user's own casing, accents and names", () => {
    expect(r.resolve("Recuerda que mi hermana se llama Ana María.")).toMatchObject({ route: "local", tool: "memory.add", args: { text: "mi hermana se llama Ana María" } });
    expect(r.resolve("jarvis, acuérdate de que prefiero el café sin azúcar")).toMatchObject({ tool: "memory.add" });
    expect(r.resolve("anota que mi cumpleaños es el 3 de mayo")).toMatchObject({ tool: "memory.add", args: { text: "mi cumpleaños es el 3 de mayo" } });
    expect(r.resolve("remember that my sister is called Ana")).toMatchObject({ tool: "memory.add", args: { text: "my sister is called Ana" } });
    expect(r.resolve("memoriza mi número de socio es 4471")).toMatchObject({ tool: "memory.add" });
  });

  it("does not mistake ordinary requests for memories", () => {
    for (const t of ["guarda el archivo", "recuerda abrir paint", "recuérdame llamar a mamá", "remember me to call mom", "qué es la memoria RAM", "anota"]) expect(r.resolve(t).route === "local" && (r.resolve(t) as { tool: string }).tool.startsWith("memory."), t).toBe(false);
  });

  it("lists, forgets, clears and toggles", () => {
    expect(r.resolve("qué recuerdas de mí")).toMatchObject({ tool: "memory.list" });
    expect(r.resolve("what do you know about me")).toMatchObject({ tool: "memory.list" });
    expect(r.resolve("olvida que mi hermana se llama Ana")).toMatchObject({ tool: "memory.forget", args: { query: "mi hermana se llama ana" } });
    expect(r.resolve("borra toda mi memoria")).toMatchObject({ tool: "memory.clear" });
    expect(r.resolve("forget everything you know about me")).toMatchObject({ tool: "memory.clear" });
    expect(r.resolve("desactiva la memoria")).toMatchObject({ tool: "memory.toggle", args: { enabled: false } });
    expect(r.resolve("activa la memoria")).toMatchObject({ tool: "memory.toggle", args: { enabled: true } });
    expect(r.resolve("abre paint")).toMatchObject({ tool: "apps.open" }); // built-in rules still win where they should
  });
});
