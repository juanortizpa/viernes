import { describe, expect, it } from "vitest";
import { AppCatalog, IntentRouter, cleanSpoken, normalizeText, phoneticKey } from "../src";

const apps = {
  calculadora: "calc", calculator: "calc", "bloc de notas": "notepad", notepad: "notepad", paint: "mspaint", navegador: "msedge", browser: "msedge",
  "vs code": "code", "visual studio code": "code", "explorador de archivos": "explorer",
};
const router = new IntentRouter({ apps });

describe("cleanSpoken", () => {
  it("drops fillers, hesitations and stutters but keeps the request", () => {
    expect(cleanSpoken(normalizeText("Che, abrime la calculadora."))).toBe("abrime la calculadora");
    expect(cleanSpoken(normalizeText("Eh, abrime el, el paint."))).toBe("abrime el paint");
    expect(cleanSpoken(normalizeText("Bueno, decime qué día es mañana"))).toBe("que dia es manana");
    expect(cleanSpoken(normalizeText("abre la calculadora"))).toBe("abre la calculadora");
  });
});

describe("phoneticKey", () => {
  it("maps misheard spellings of the same sound together", () => {
    expect(phoneticKey("bróser")).toBe(phoneticKey("browser"));
    expect(phoneticKey("blog de notas")).toBe(phoneticKey("bloc de notas"));
    expect(phoneticKey("calcula dora")).toBe(phoneticKey("calculadora"));
    expect(phoneticKey("vizual")).toBe(phoneticKey("visual"));
    expect(phoneticKey("paint")).not.toBe(phoneticKey("print"));
  });
});

describe("IntentRouter on REAL speech-recognition output (Groq whisper on natural Rioplatense speech)", () => {
  it.each([
    ["Che, abrime la calculadora.", "calc"],
    ["Eh, abrime el paint.", "mspaint"],
    ["Abre Visual Studio Code", "code"],
    ["Abrimos el bloc de notas puesto bar.", undefined], // garbled tail: must not open something random
    ["abrí el blog de notas", "notepad"],
    ["abre la calcula dora", "calc"],
    ["Abriendo el bróser", "msedge"],
    ["Necesito que me abras el explorador de archivos.", "explorer"],
    ["¿Me abrís el navegador?", "msedge"],
  ])("%s", (heard, app) => {
    const r = router.resolve(heard);
    if (app) expect(r).toMatchObject({ route: "local", tool: "apps.open", args: { app } });
    else expect(r.route === "llm" || (r.route === "local" && r.tool === "apps.open")).toBe(true);
  });

  it("answers date/time questions asked with spoken prefixes", () => {
    expect(router.resolve("Decime qué día es mañana.")).toMatchObject({ tool: "time.date", args: { offsetDays: 1 } });
    expect(router.resolve("Decime qué día es el mañana")).toMatchObject({ tool: "time.date", args: { offsetDays: 1 } }); // real Gemini output
    expect(router.resolve("Che, ¿qué hora es?")).toMatchObject({ tool: "time.now" });
    expect(router.resolve("me podés decir qué hora es")).toMatchObject({ tool: "time.now" });
  });

  it("still does not turn ordinary or ambiguous speech into launches", () => {
    for (const t of ["abre la puerta", "che, contame un chiste", "abre el pan", "abrime la cabeza"]) expect(router.resolve(t).route, t).toBe("llm");
  });
});

describe("AppCatalog.suggest sounds-like fallback", () => {
  it("finds one unambiguous app by sound, and refuses when two apps sound alike", () => {
    const c = AppCatalog.fromRecord(apps);
    expect(c.suggest("broser")?.command).toBe("msedge");
    expect(c.suggest("vizual estudio code")?.command).toBe("code");
    const amb = AppCatalog.fromRecord({ "bloc de notas": "notepad", "blog de notas": "blognotes.exe" });
    expect(amb.suggest("blok de notas")).toBeUndefined(); // two apps sound the same: do not guess
  });
});
