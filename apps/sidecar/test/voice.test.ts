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
