import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "@jarvis/protocol";
import { LiveClient, type SocketLike } from "./client";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {}
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) + "\n" });
  }
}

const setup = () => {
  const socket = new FakeSocket();
  const client = new LiveClient({ fetchToken: async () => "tok", openSocket: () => socket });
  return { socket, client };
};

const ready = async () => {
  const h = setup();
  await h.client.connect();
  h.socket.onopen?.();
  h.socket.receive({ type: "hello.ok", protocol: 1, models: ["m"], offline: true });
  return h;
};

describe("LiveClient", () => {
  it("sends hello with the token and becomes ready on hello.ok", async () => {
    const { socket, client } = setup();
    await client.connect();
    socket.onopen?.();
    expect(socket.sent[0]).toEqual({ type: "hello", token: "tok", protocol: 1 });
    expect(client.status).toBe("connecting");
    socket.receive({ type: "hello.ok", protocol: 1, models: ["m"], offline: true });
    expect(client.status).toBe("ready");
    expect(client.info).toEqual({ models: ["m"], offline: true, voice: false });
  });

  it("forwards only valid events and ignores garbage", async () => {
    const { socket, client } = await ready();
    const got: OrchestratorEvent[] = [];
    client.onEvent((e) => got.push(e));
    socket.receive({ type: "event", event: { type: "bogus" } });
    expect(got).toHaveLength(0);
    expect(client.lastError).toMatch(/inválido/);
    socket.receive({
      type: "event",
      event: { id: "1", taskId: "t", seq: 0, ts: 1, type: "task.started", input: "hola", modality: "text" },
    });
    expect(got.map((e) => e.type)).toEqual(["task.started"]);
  });

  it("sends submit, cancel and permission answers", async () => {
    const { socket, client } = await ready();
    client.submit("hola");
    client.answerPermission("r1", true);
    client.cancel();
    expect(socket.sent.slice(1)).toEqual([
      { type: "task.submit", input: "hola", modality: "text" },
      { type: "permission.answer", requestId: "r1", granted: true },
      { type: "task.cancel" },
    ]);
  });

  it("refuses to send before ready", () => {
    expect(() => setup().client.submit("x")).toThrow(/not ready/);
  });

  it("is unavailable when the token endpoint fails, on hello.error and on close", async () => {
    const a = new LiveClient({
      fetchToken: async () => {
        throw new Error("404");
      },
      openSocket: () => new FakeSocket(),
    });
    await a.connect();
    expect(a.status).toBe("unavailable");

    const b = setup();
    await b.client.connect();
    b.socket.receive({ type: "hello.error", message: "handshake rejected" });
    expect(b.client.status).toBe("unavailable");

    const c = await ready();
    c.socket.onclose?.();
    expect(c.client.status).toBe("unavailable");
  });

  it("sends voice clips and surfaces what the sidecar heard or rejected", async () => {
    const { socket, client } = await ready();
    const notices: unknown[] = [];
    client.onVoice((n) => notices.push(n));
    client.submitVoice("QUJD".repeat(40));
    expect(socket.sent.at(-1)).toMatchObject({ type: "voice.submit" });
    socket.receive({ type: "voice.transcribed", text: "hola", audioMs: 800, latencyMs: 300 });
    socket.receive({ type: "voice.rejected", reason: "silence", message: "No se detectó voz" });
    expect(notices).toEqual([
      { kind: "transcribed", text: "hola", audioMs: 800, latencyMs: 300 },
      { kind: "rejected", reason: "silence", message: "No se detectó voz" },
    ]);
  });

  it("knows whether voice is available", async () => {
    const h = await ready();
    expect(h.client.info?.voice).toBe(false);
  });
});
