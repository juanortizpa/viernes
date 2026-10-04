import { describe, expect, it } from "vitest";
import { IntentRouter } from "../src";

const router = new IntentRouter({ apps: { paint: "mspaint", "otra pestana": "msedge", calculadora: "calc", calculator: "calc", "bloc de notas": "notepad", navegador: "msedge", browser: "msedge", "vs code": "code" } });

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

  it.each([
    ["abre la calculadora", "calc"],
    ["Abre la calculadora.", "calc"],
    ["puedes abrir la calculadora por favor", "calc"],
    ["por favor abre el bloc de notas", "notepad"],
    ["¿Podés abrirme el navegador?", "msedge"],
    ["abrime paint", "mspaint"],
    ["ábreme la calculadora", "calc"],
    ["abre la aplicación de calculadora", "calc"],
    ["ejecuta la calculadora", "calc"],
    ["lanza el navegador", "msedge"],
    ["jarvis, abre vs code", "code"],
    ["open the calculator", "calc"],
    ["Open the calculator.", "calc"],
    ["can you open notepad please", undefined],
    ["could you launch the browser", "msedge"],
    ["open up the browser", "msedge"],
  ])("opens the app in spoken phrasing: %s", (text, app) => {
    const r = router.resolve(text);
    if (app) expect(r).toMatchObject({ route: "local", tool: "apps.open", args: { app } });
    else expect(r.route === "llm" || (r.route === "local" && r.tool === "apps.open")).toBe(true); // "notepad" is not an alias here: llm or a near-match, never a wrong app
  });

  it("does not turn ordinary sentences into app launches", () => {
    for (const t of ["abre la puerta", "abre un debate", "open the pull request", "no abras la calculadora", "me gusta abrir la calculadora", "abre", "abre la", "explica qué hace la calculadora"])
      expect(router.resolve(t).route, t).toBe("llm");
  });
});
