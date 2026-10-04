import { describe, expect, it } from "vitest";
import { EventBus, IntentRouter, MemoryTraceStore, Orchestrator, StaticRouter } from "@jarvis/core";
import type { ServerMessage } from "@jarvis/ipc";
import { PolicyEngine } from "@jarvis/policy";
import type { ModelCapabilities, OrchestratorEvent } from "@jarvis/protocol";
import { FakeProvider, ProviderRegistry, type FakeReply } from "@jarvis/providers";
import { ToolRegistry, makeAppsOpen } from "@jarvis/tools";
import { decodeWav, type Transcriber } from "@jarvis/voice";
import { SidecarServer } from "../src/server";
import { sameRequest } from "../src/speculation";

const RATE = 16_000;
const caps: ModelCapabilities = { model: "m", provider: "fake", supportsVision: false, supportsTools: true, supportsStreaming: true, contextWindow: 10_000, estimatedInputCost: 0, estimatedOutputCost: 0, expectedLatency: 1, isLocal: false };
const tick = (ms = 4) => new Promise((r) => setTimeout(r, ms));
const tone = (ms: number) => Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / RATE));
const silence = (ms: number) => new Float32Array((RATE * ms) / 1000);
const pcm16 = (x: Float32Array): string => {
  const b = Buffer.alloc(x.length * 2);
  x.forEach((v, i) => b.writeInt16LE(Math.round(v * 32767), i * 2));
  return b.toString("base64");
};
const speechMs = (wav: Uint8Array): number => {
  const s = decodeWav(wav).samples;
  let loud = 0;
  for (let i = 0; i < s.length; i += 320) if (Math.abs(s[i + 80] ?? 0) > 0.02) loud += 20;
  return loud;
};

/** Partial/final engines that "hear" a script by how much speech the clip has. */
const engine = (script: (speechMs: number) => string, calls: string[], name: string, confidence = 0.9): Transcriber => ({
  async transcribe(wav) {
    calls.push(name);
    await tick(10);
    return { text: script(speechMs(wav)), audioMs: 0, latencyMs: 10, confidence, engine: name };
  },
});

function setup(opts: { reply?: (step: number) => FakeReply; script: (ms: number) => string; partialConfidence?: number }) {
  const out: ServerMessage[] = [];
  const modelCalls: string[] = [];
  const sttCalls: string[] = [];
  const launched: string[] = [];
  const traces = new MemoryTraceStore();
  let step = 0;
  const server = new SidecarServer({
    token: "t",
    send: (m) => out.push(m),
    bus: new EventBus(),
    info: { models: ["m"], offline: false },
    transcriber: engine(opts.script, sttCalls, "final"),
    streaming: { partial: engine(opts.script, sttCalls, "partial", opts.partialConfidence ?? 0.9), accept: (t) => (t.confidence ?? 0) >= 0.7, worthSpeculating: (t) => !/^abr/i.test(t) },
    createOrchestrator: ({ bus, askPermission }) =>
      new Orchestrator({
        bus,
        intents: new IntentRouter({ apps: { calculadora: "calc" } }),
        router: new StaticRouter("m"),
        providers: new ProviderRegistry().register(
          new FakeProvider("fake", [caps], (req) => {
            modelCalls.push((req.messages.at(-1) as { content: string }).content);
            return (opts.reply ?? (() => "Un closure es una función que recuerda su entorno."))(step++);
          }),
        ),
        tools: new ToolRegistry().register(makeAppsOpen(async (a) => void launched.push(a))),
        policy: new PolicyEngine(),
        askPermission,
        traces,
      }),
  });
  server.handleLine(JSON.stringify({ type: "hello", token: "t", protocol: 1 }));
  const send = (m: unknown) => server.handleLine(JSON.stringify(m));
  const say = async (id: string, parts: Float32Array[]) => {
    send({ type: "voice.stream.start", id });
    for (const p of parts) for (let i = 0; i < p.length; i += 3200) (send({ type: "voice.stream.chunk", id, pcm: pcm16(p.subarray(i, i + 3200)) }), await tick());
  };
  const events = (): OrchestratorEvent[] => out.flatMap((m) => (m.type === "event" ? [m.event] : []));
  return { server, out, send, say, events, modelCalls, sttCalls, launched, traces };
}

describe("thinking from the first words (ADR-0029)", () => {
  it("the answer starts while the user is still talking; nothing reaches the UI until their words confirm it", async () => {
    const s = setup({ script: (ms) => (ms < 900 ? "explicame los" : "explicame los closures") });
    await s.say("a", [tone(1500), silence(400)]);
    await tick(30);
    expect(s.modelCalls).toEqual(["explicame los closures"]); // already thinking
    expect(s.events()).toEqual([]); // ...but invisibly
    expect(s.out.filter((m) => m.type === "voice.partial").length).toBeGreaterThan(0); // live caption
    s.send({ type: "voice.stream.end", id: "a" });
    await s.server.idle();
    const tr = s.out.find((m) => m.type === "voice.transcribed") as Extract<ServerMessage, { type: "voice.transcribed" }>;
    expect(tr).toMatchObject({ text: "explicame los closures", speculated: true });
    expect(tr.afterEndMs).toBeLessThan(50); // the pause partial was reused: no transcription after the end
    expect(s.sttCalls.filter((c) => c === "final")).toEqual([]);
    expect(s.modelCalls).toHaveLength(1); // the speculative call IS the answer
    const types = s.events().map((e) => e.type);
    expect(types[0]).toBe("task.started");
    expect(types).toContain("response.delta");
    expect(s.events().find((e) => e.type === "task.finished")).toMatchObject({ outcome: "success" });
    expect(s.out.findIndex((m) => m.type === "voice.transcribed")).toBeLessThan(s.out.findIndex((m) => m.type === "event"));
    expect(s.traces.traces[0]!.speculation).toBe("committed");
  });

  it("if the user keeps talking after the guess, the guess is dropped without a trace and the real request runs", async () => {
    const s = setup({ script: (ms) => (ms < 1300 ? "explicame los closures" : "explicame los closures en python") });
    await s.say("b", [tone(1500), silence(400), tone(700)]);
    s.send({ type: "voice.stream.end", id: "b" });
    await s.server.idle();
    expect(s.modelCalls).toEqual(["explicame los closures", "explicame los closures en python"]);
    const started = s.events().filter((e) => e.type === "task.started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ input: "explicame los closures en python" });
    expect(s.out.find((m) => m.type === "voice.transcribed")).toMatchObject({ speculated: false });
    expect(s.traces.traces.map((t) => t.speculation)).toEqual(["discarded", undefined]);
  });

  it("a guess may think but never act: a tool above read waits for the user's words", async () => {
    const s = setup({
      script: () => "poneme la calculadora",
      reply: (i) => (i === 0 ? { toolCalls: [{ id: "c", name: "apps.open", args: { app: "calc" } }] } : "Listo."),
    });
    await s.say("c", [tone(1200), silence(400)]);
    await tick(40);
    expect(s.modelCalls).toHaveLength(1); // the model already asked for the tool...
    expect(s.launched).toEqual([]); // ...which has not run
    s.send({ type: "voice.stream.end", id: "c" });
    await s.server.idle();
    expect(s.launched).toEqual(["calc"]);
  });

  it("a discarded guess never runs its tool", async () => {
    const s = setup({
      script: (ms) => (ms < 1300 ? "poneme la calculadora" : "poneme la calculadora no mejor nada"),
      reply: (i) => (i === 0 ? { toolCalls: [{ id: "c", name: "apps.open", args: { app: "calc" } }] } : "Ok, nada."),
    });
    await s.say("d", [tone(1500), silence(400), tone(700)]);
    s.send({ type: "voice.stream.end", id: "d" });
    await s.server.idle();
    // The guess asked for the tool and was dropped; the confirmed request ("…no, mejor nada") got a plain answer.
    expect(s.modelCalls).toEqual(["poneme la calculadora", "poneme la calculadora no mejor nada"]);
    expect(s.launched).toEqual([]);
    expect(s.events().filter((e) => e.type === "task.started").map((e) => (e as { input: string }).input)).toEqual(["poneme la calculadora no mejor nada"]);
  });

  it("no guessing on low-confidence partials or local commands; silence is rejected; cancel drops everything", async () => {
    const low = setup({ script: () => "explicame algo raro", partialConfidence: 0.4 });
    await low.say("e", [tone(1200), silence(400)]);
    await tick(30);
    expect(low.modelCalls).toEqual([]);
    low.send({ type: "voice.stream.end", id: "e" });
    await low.server.idle();
    expect(low.sttCalls.at(-1)).toBe("final"); // untrusted partial → full transcription

    const local = setup({ script: () => "abrí la calculadora" });
    await local.say("f", [tone(1200), silence(400)]);
    await tick(30);
    expect(local.modelCalls).toEqual([]);

    const quiet = setup({ script: () => "" });
    await quiet.say("g", [silence(1500)]);
    quiet.send({ type: "voice.stream.end", id: "g" });
    await quiet.server.idle();
    expect(quiet.out.find((m) => m.type === "voice.rejected")).toMatchObject({ reason: "silence" });

    const c = setup({ script: () => "explicame los closures" });
    await c.say("h", [tone(1500), silence(400)]);
    c.send({ type: "task.cancel" });
    await c.server.idle();
    expect(c.events()).toEqual([]);
  });
});

describe("sameRequest", () => {
  it("ignores punctuation, case, accents, the wake word and edge fillers — nothing else", () => {
    expect(sameRequest("¿Qué es un closure?", "que es un closure")).toBe(true);
    expect(sameRequest("Jarvis, qué hora es", "qué hora es")).toBe(true);
    expect(sameRequest("qué es un closure", "qué es un closure en python")).toBe(false);
    expect(sameRequest("", "")).toBe(false);
  });
});
