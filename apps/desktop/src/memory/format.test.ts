import { describe, expect, it } from "vitest";
import { memoryView } from "./format";

describe("memoryView", () => {
  it("says what is remembered, how often it was used, and warns when memory is off", () => {
    const now = 10_000_000;
    const v = memoryView(
      {
        enabled: false,
        conversationTurns: 2,
        items: [
          { id: "a", kind: "fact", text: "vivo en Cali", createdAt: 1, uses: 0 },
          { id: "b", kind: "preference", text: "siempre tutéame", createdAt: 2, uses: 3, usedAt: now - 5 * 60_000 },
        ],
      },
      now,
    );
    expect(v.summary).toContain("Recuerdo 2 cosas.");
    expect(v.summary).toContain("desactivada");
    expect(v.summary).toContain("2 intercambios");
    expect(v.items.map((i) => [i.kindLabel, i.usage])).toEqual([["Dato", "aún no usado"], ["Preferencia", "usado 3 veces, hace 5 min"]]);
    expect(v.privacy).toContain("sale de tu equipo");
  });

  it("an empty book says so instead of inventing content", () => {
    const v = memoryView({ enabled: true, conversationTurns: 0, items: [] });
    expect(v.summary).toBe("No me pediste recordar nada. Esta conversación aún no tiene contexto.");
    expect(v.items).toEqual([]);
  });
});
