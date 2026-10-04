import { describe, expect, it } from "vitest";
import { SpeechController, type SynthLike, type UtteranceLike } from "./controller";
import { parseSpeakMode, shouldSpeak } from "./policy";
import { localConfirmation, speakable } from "./text";
import { pickVoice, type VoiceInfo } from "./voices";

describe("speakable", () => {
  it("strips markdown and keeps the first sentences", () => {
    const r = speakable("# Título\n**Hola**, la capital es `París`. Tiene 2 millones de habitantes. Es famosa por la torre. Y por mucho más.", "es");
    expect(r.text).toBe("Título. Hola, la capital es París. Tiene 2 millones de habitantes. Te dejé el detalle en pantalla.");
    expect(r.truncated).toBe(true);
  });

  it("never reads code or tables aloud and says it left them on screen", () => {
    const code = speakable("Aquí está la función:\n```js\nconst x = 1;\nconsole.log(x)\n```\nListo.", "es");
    expect(code.text).not.toMatch(/const|console/);
    expect(code.skippedStructured).toBe(true);
    expect(code.text).toMatch(/pantalla/);
    const table = speakable("| a | b |\n|---|---|\n| 1 | 2 |", "es");
    expect(table.text).toBe("Te dejé el detalle en pantalla.");
    expect(speakable("```js\nx\n```", "en").text).toBe("I left the details on screen.");
  });

  it("replaces URLs and drops images/links syntax", () => {
    expect(speakable("Mira https://example.com/a?b=1 y [esto](http://x.y).", "es").text).toBe("Mira un enlace y esto.");
  });

  it("caps a single enormous sentence and handles empty input", () => {
    const r = speakable("palabra ".repeat(200), "es");
    expect(r.text.length).toBeLessThan(330);
    expect(speakable("   ", "es").text).toBe("");
  });
});

describe("localConfirmation", () => {
  it("says something a person would instead of the English machine summary", () => {
    expect(localConfirmation("apps.open", true, "opened calc")).toBe("Listo.");
    expect(localConfirmation("apps.open", false, "cannot open x: ENOENT")).toBe("No pude completarlo.");
    expect(localConfirmation("time.now", true, "domingo, 4 de octubre de 2026, 3:02:56")).toMatch(/domingo/);
    expect(localConfirmation("apps.open", true, "opened calc", "en")).toBe("Done.");
  });
});

describe("pickVoice", () => {
  const v = (name: string, lang: string, localService = true, def = false): VoiceInfo => ({ name, lang, localService, default: def });
  const voices = [v("EN", "en-US"), v("ES-ES", "es-ES"), v("ES-MX online", "es-MX", false), v("ES-MX", "es_MX"), v("ES-AR online", "es-AR", false)];
  it("prefers Rioplatense, then other regions; offline before online within a region; undefined if the language is missing", () => {
    expect(pickVoice(voices, "es")?.name).toBe("ES-AR online");
    expect(pickVoice(voices.filter((x) => x.name !== "ES-AR online"), "es")?.name).toBe("ES-MX");
    expect(pickVoice(voices, "en")?.name).toBe("EN");
    expect(pickVoice([v("EN", "en-US")], "es")).toBeUndefined();
    expect(pickVoice(voices, "es", "ES-ES")?.name).toBe("ES-ES"); // explicit choice wins
  });
});

describe("policy", () => {
  it("speaks per the chosen mode", () => {
    expect(shouldSpeak("voice", "voice")).toBe(true);
    expect(shouldSpeak("voice", "text")).toBe(false);
    expect(shouldSpeak("always", "text")).toBe(true);
    expect(shouldSpeak("never", "voice")).toBe(false);
    expect(parseSpeakMode("garbage")).toBe("voice");
    expect(parseSpeakMode(null)).toBe("voice");
  });
});

class FakeSynth implements SynthLike {
  spoken: UtteranceLike[] = [];
  cancelled = 0;
  constructor(public voices: (VoiceInfo & { voiceURI?: string })[] = [{ name: "ES", lang: "es-AR", localService: true }]) {}
  getVoices() {
    return this.voices;
  }
  speak(u: UtteranceLike) {
    this.spoken.push(u);
  }
  cancel() {
    this.cancelled++;
  }
}
const utt = (text: string): UtteranceLike => ({ text, lang: "", rate: 1, voice: undefined, onstart: null, onend: null, onerror: null });

describe("SpeechController", () => {
  const setup = (voices?: (VoiceInfo & { voiceURI?: string })[]) => {
    const synth = new FakeSynth(voices);
    const log: string[] = [];
    let t = 1000;
    const c = new SpeechController(synth, utt, { onStart: (ms, text) => log.push(`start:${text}:${ms}`), onIdle: () => log.push("idle"), onNoVoice: (l) => log.push(`novoice:${l}`) }, { now: () => t });
    return { synth, log, c, tick: (ms: number) => (t += ms) };
  };

  it("queues utterances so an acknowledgement is not cut off by the answer, and reports real start/idle with latency", () => {
    const { synth, log, c, tick } = setup();
    c.speak("Entendido.", "es");
    tick(120);
    c.speak("La respuesta.", "es");
    expect(synth.spoken).toHaveLength(1); // the second waits
    synth.spoken[0]!.onstart?.();
    expect(c.speaking).toBe(true);
    synth.spoken[0]!.onend?.();
    expect(synth.spoken).toHaveLength(2);
    synth.spoken[1]!.onstart?.();
    synth.spoken[1]!.onend?.();
    expect(log).toEqual(["start:Entendido.:120", "start:La respuesta.:0", "idle"]);
    expect(c.speaking).toBe(false);
    expect(synth.spoken[0]).toMatchObject({ lang: "es-AR", voice: { name: "ES" } });
  });

  it("cancel stops now, clears the queue and ignores the cancelled utterance's late callbacks", () => {
    const { synth, log, c } = setup();
    c.speak("uno", "es");
    c.speak("dos", "es");
    synth.spoken[0]!.onstart?.();
    c.cancel();
    expect(synth.cancelled).toBe(1);
    synth.spoken[0]!.onend?.(); // arrives after cancel
    expect(synth.spoken).toHaveLength(1); // "dos" was dropped, not started
    expect(log).toEqual(["start:uno:0", "idle"]);
    expect(c.speaking).toBe(false);
  });

  it("stays silent (and says so) when no installed voice speaks the language", () => {
    const { synth, log, c } = setup([{ name: "EN", lang: "en-US", localService: true }]);
    c.speak("hola", "es");
    expect(synth.spoken).toHaveLength(0);
    expect(log).toEqual(["novoice:es"]);
  });

  it("ignores empty text and survives an utterance error", () => {
    const { synth, c } = setup();
    c.speak("   ", "es");
    expect(synth.spoken).toHaveLength(0);
    c.speak("a", "es");
    c.speak("b", "es");
    synth.spoken[0]!.onerror?.({ error: "synthesis-failed" });
    expect(synth.spoken).toHaveLength(2);
  });
});
