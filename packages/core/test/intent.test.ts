import { describe, expect, it } from "vitest";
import { IntentRouter } from "../src";

const router = new IntentRouter({ apps: { paint: "mspaint", "otra pestana": "msedge" } });

describe("IntentRouter", () => {
  it.each([
    ["¿Qué día será mañana?", 1],
    ["que dia es hoy", 0],
    ["qué día fue ayer", -1],
    ["what day will be tomorrow", 1],
  ])("resolves %s to time.date", (text, offsetDays) => {
    expect(router.resolve(text)).toMatchObject({ route: "local", tool: "time.date", args: { offsetDays } });
  });

  it("opens known apps, including accented aliases", () => {
    expect(router.resolve("abre Paint")).toMatchObject({ tool: "apps.open", args: { app: "mspaint" } });
    expect(router.resolve("Abre otra pestaña")).toMatchObject({ tool: "apps.open", args: { app: "msedge" } });
  });

  it("sends unknown requests to the LLM", () => {
    expect(router.resolve("abre un debate").route).toBe("llm");
  });
});
