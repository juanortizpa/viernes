import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@jarvis/ipc";
import { EventBus } from "@jarvis/core";
import { FakeTranscriber, encodeWav, type Transcriber } from "@jarvis/voice";
import { buildRuntime } from "../src/runtime";
import { Config } from "../src/config";
import { SidecarServer } from "../src/server";

const tone = (ms: number, amp = 0.3, rate = 48_000) =>
  encodeWav({ samples: Float32Array.from({ length: Math.round((ms / 1000) * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / rate)), sampleRate: rate });
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

function harness(transcriber?: Transcriber) {
  const out: ServerMessage[] = [];
  const runtime = buildRuntime(Config.parse({}), { env: {}, launcher: async () => {}, transcriber });
  const server = new SidecarServer({
    token: "t", send: (m) => out.push(m), bus: new EventBus(), createOrchestrator: runtime.createOrchestrator,
    info: { models: runtime.models, offline: runtime.offline }, transcriber: runtime.transcriber, economy: runtime.economy,
  });
  const send = (m: unknown) => server.handleLine(JSON.stringify(m));
  send({ type: "hello", token: "t", protocol: 1 });
  const events = () => out.flatMap((m) => (m.type === "event" ? [m.event] : []));
  return { server, out, send, events };
}

describe("push-to-talk over IPC", () => {
  it("advertises voice only when an engine is configured", () => {
    expect(harness(new FakeTranscriber()).out[0]).toMatchObject({ type: "hello.ok", voice: true });
    expect(harness().out[0]).toMatchObject({ type: "hello.ok", voice: false });
  });

  it("transcribes a clip, reports what was heard, then runs it as a voice task through the normal pipeline", async () => {
    const stt = new FakeTranscriber("qué hora es");
    const h = harness(stt);
    h.send({ type: "voice.submit", audio: b64(tone(800)) });
    await h.server.idle();
    expect(h.out.find((m) => m.type === "voice.transcribed")).toMatchObject({ text: "qué hora es", audioMs: 800 });
    const started = h.events().find((e) => e.type === "task.started");
    expect(started).toMatchObject({ modality: "voice", input: "qué hora es" });
    expect(h.events().some((e) => e.type === "tool.completed")).toBe(true); // routed to the local time intent like typed text
    const wav = stt.calls[0]!; // the engine got a normalised 16 kHz clip
    expect(new DataView(wav.buffer, wav.byteOffset).getUint32(24, true)).toBe(16_000);
  });

  it("rejects silence, short and corrupt clips BEFORE the engine runs", async () => {
    const stt = new FakeTranscriber("Gracias por ver el video"); // what a hallucinating engine would say on silence
    const h = harness(stt);
    for (const audio of [b64(tone(1500, 0)), b64(tone(100)), Buffer.alloc(300, 7).toString("base64")]) h.send({ type: "voice.submit", audio });
    await h.server.idle();
    expect(h.out.filter((m) => m.type === "voice.rejected").map((m) => (m as { reason: string }).reason)).toEqual(["silence", "too_short", "invalid"]);
    expect(stt.calls).toHaveLength(0);
    expect(h.events()).toHaveLength(0);
  });

  it("says so when no engine is configured, when it returns nothing and when it crashes", async () => {
    const none = harness();
    none.send({ type: "voice.submit", audio: b64(tone(800)) });
    expect(none.out.at(-1)).toMatchObject({ type: "voice.rejected", reason: "unavailable" });

    const empty = harness(new FakeTranscriber(""));
    empty.send({ type: "voice.submit", audio: b64(tone(800)) });
    await empty.server.idle();
    expect(empty.out.at(-1)).toMatchObject({ type: "voice.rejected", reason: "empty" });
    expect(empty.events()).toHaveLength(0);

    const boom = harness({ transcribe: async () => { throw new Error("whisper exploded: C:\\secret\\path"); } });
    boom.send({ type: "voice.submit", audio: b64(tone(800)) });
    await boom.server.idle();
    const last = boom.out.at(-1) as { reason: string; message: string };
    expect(last.reason).toBe("failed");
    expect(last.message).not.toMatch(/secret|exploded/); // internals are logged, not shown
  });

  it("task.cancel aborts a transcription in flight", async () => {
    let seen: AbortSignal | undefined;
    const h = harness({ transcribe: (_w, o) => new Promise((_res, rej) => { seen = o?.signal; o?.signal?.addEventListener("abort", () => rej(new Error("aborted"))); }) });
    h.send({ type: "voice.submit", audio: b64(tone(800)) });
    await new Promise((r) => setTimeout(r, 20));
    h.send({ type: "task.cancel" });
    await h.server.idle();
    expect(seen?.aborted).toBe(true);
    expect(h.out.at(-1)).toMatchObject({ type: "voice.rejected", reason: "cancelled" });
  });
});

describe("economy over IPC", () => {
  it("summarises the stored traces of finished tasks", async () => {
    const h = harness();
    h.send({ type: "task.submit", input: "qué hora es" });
    h.send({ type: "task.submit", input: "hola" });
    await h.server.idle();
    h.send({ type: "economy.get" });
    const m = h.out.find((x) => x.type === "economy") as Extract<ServerMessage, { type: "economy" }>;
    expect(m.summary).toMatchObject({ tasks: 2, byKind: { local: 1, instant: 1, model: 0, cache: 0 }, costUsd: 0, savedPct: null });
  });
});

describe("wake-word verification (stage 2) over IPC", () => {
  const wakeHarness = (say: string, tr?: Transcriber) => {
    const stt = new FakeTranscriber(say);
    const h = harness(tr ?? stt);
    return { ...h, stt };
  };
  const results = (h: { out: ServerMessage[] }) => h.out.filter((m) => m.type === "wake.result") as Extract<ServerMessage, { type: "wake.result" }>[];

  it("wake word alone: detected, nothing run", async () => {
    const h = wakeHarness("Jarvis.");
    h.send({ type: "wake.verify", audio: b64(tone(900)) });
    await h.server.idle();
    expect(results(h)).toEqual([{ type: "wake.result", detected: true, commandRan: false }]);
    expect(h.events()).toHaveLength(0);
  });

  it("wake word + command in one breath: runs the command as a voice task, telling the UI what was heard first", async () => {
    const h = wakeHarness("Jarvis, qué hora es");
    h.send({ type: "wake.verify", audio: b64(tone(900)) });
    await h.server.idle();
    const types = h.out.map((m) => m.type);
    expect(types.indexOf("voice.transcribed")).toBeLessThan(types.indexOf("wake.result"));
    expect(h.out.find((m) => m.type === "voice.transcribed")).toMatchObject({ text: "qué hora es" });
    expect(results(h)).toEqual([{ type: "wake.result", detected: true, commandRan: true }]);
    expect(h.events().find((e) => e.type === "task.started")).toMatchObject({ modality: "voice", input: "qué hora es" });
    expect(h.events().some((e) => e.type === "tool.completed")).toBe(true);
  });

  it("an utterance that is not for the assistant is dropped: no task, no echo of the text, nothing stored", async () => {
    const h = wakeHarness("abre la calculadora, la otra tarde le dije a jarvis algo");
    h.send({ type: "wake.verify", audio: b64(tone(900)) });
    await h.server.idle();
    expect(results(h)).toEqual([{ type: "wake.result", detected: false, commandRan: false }]);
    expect(h.events()).toHaveLength(0);
    expect(JSON.stringify(h.out)).not.toMatch(/calculadora|otra tarde/);
  });

  it("silence never reaches the engine, and failures are reported without internals", async () => {
    const h = wakeHarness("Jarvis");
    h.send({ type: "wake.verify", audio: b64(tone(1500, 0)) });
    await h.server.idle();
    expect(h.stt.calls).toHaveLength(0);
    expect(results(h)).toEqual([{ type: "wake.result", detected: false, commandRan: false }]);

    const boom = harness({ transcribe: async () => { throw new Error("C:\\secret exploded"); } });
    boom.send({ type: "wake.verify", audio: b64(tone(900)) });
    await boom.server.idle();
    expect(boom.out.at(-1)).toEqual({ type: "wake.result", detected: false, commandRan: false, reason: "failed" });

    const none = harness();
    none.send({ type: "wake.verify", audio: b64(tone(900)) });
    expect(none.out.at(-1)).toMatchObject({ type: "wake.result", reason: "unavailable" });
  });

  it("uses the lighter wake engine for verification when one is configured", async () => {
    const wake = new FakeTranscriber("Jarvis");
    const main = new FakeTranscriber("nope");
    const out: ServerMessage[] = [];
    const runtime = buildRuntime(Config.parse({}), { env: {}, launcher: async () => {}, transcriber: main });
    const server = new SidecarServer({ token: "t", send: (m) => out.push(m), bus: new EventBus(), createOrchestrator: runtime.createOrchestrator, info: { models: [], offline: true }, transcriber: main, wakeTranscriber: wake });
    server.handleLine(JSON.stringify({ type: "hello", token: "t", protocol: 1 }));
    server.handleLine(JSON.stringify({ type: "wake.verify", audio: b64(tone(900)) }));
    await server.idle();
    expect(wake.calls).toHaveLength(1);
    expect(main.calls).toHaveLength(0);
  });
});

describe("wake + command in one breath uses the accurate engine for the command", () => {
  it("re-transcribes the same clip with the main engine and keeps the fast one only as a fallback", async () => {
    const out: ServerMessage[] = [];
    const tiny = new FakeTranscriber("Jarvis, abre la cálcula");
    const big: Transcriber = { transcribe: async () => ({ text: "Jarvis, abre la calculadora", audioMs: 900, latencyMs: 300, engine: "groq:whisper-large-v3-turbo" }) };
    const runtime = buildRuntime(Config.parse({}), { env: {}, launcher: async () => {}, transcriber: big });
    const server = new SidecarServer({ token: "t", send: (m) => out.push(m), bus: new EventBus(), createOrchestrator: runtime.createOrchestrator, info: { models: [], offline: true }, transcriber: big, wakeTranscriber: tiny });
    server.handleLine(JSON.stringify({ type: "hello", token: "t", protocol: 1 }));
    server.handleLine(JSON.stringify({ type: "wake.verify", audio: b64(tone(900)) }));
    await server.idle();
    expect(out.find((m) => m.type === "voice.transcribed")).toMatchObject({ text: "abre la calculadora", engine: "groq:whisper-large-v3-turbo" });
    // ...and it is that accurate text that RUNS (it used to run the fast engine's "abre la cálcula").
    const started = out.find((m) => m.type === "event" && m.event.type === "task.started") as Extract<ServerMessage, { type: "event" }>;
    expect(started.event).toMatchObject({ input: "abre la calculadora" });
    expect(out.some((m) => m.type === "event" && m.event.type === "permission.required")).toBe(false);
  });
});
