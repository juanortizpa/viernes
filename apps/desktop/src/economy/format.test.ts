import { describe, expect, it } from "vitest";
import type { EconomySummary } from "@jarvis/protocol";
import { economyView, usd } from "./format";

const base: EconomySummary = {
  tasks: 10, byKind: { model: 6, local: 2, instant: 1, cache: 1 }, successRate: 0.9, escalatedTasks: 1, inputTokens: 1200, outputTokens: 800,
  costUsd: 0.002, baselineCostUsd: 0.01, savedUsd: 0.008, savedPct: 0.8, avgLatencyMs: { model: 900, noLlm: 12 }, models: [{ model: "m", tasks: 6, costUsd: 0.002 }],
};

describe("economyView", () => {
  it("reports savings against the premium baseline when prices exist", () => {
    const v = economyView(base);
    expect(v.savingsNote).toMatch(/premium.*\$0\.00800.*80%/);
    expect(v.rows.find((r) => r.label === "Sin LLM")?.value).toBe("4 (2 locales · 1 rápidas · 1 de caché)");
  });

  it("never claims a dollar saving without a priced baseline", () => {
    const v = economyView({ ...base, costUsd: 0, baselineCostUsd: 0, savedUsd: 0, savedPct: null });
    expect(v.savingsNote).toMatch(/Sin ahorro en dólares/);
    expect(v.savingsNote).not.toMatch(/%/);
  });

  it("handles an empty history", () => {
    expect(economyView({ ...base, tasks: 0, byKind: { model: 0, local: 0, instant: 0, cache: 0 }, successRate: 0 }).headline).toBe("Aún no hay tareas registradas");
    expect(usd(0)).toBe("$0");
  });
});
