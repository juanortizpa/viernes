import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@jarvis/ipc";
import { EventBus } from "@jarvis/core";
import { buildRuntime } from "../src/runtime";
import { Config } from "../src/config";
import { SidecarServer } from "../src/server";

function harness(opts: { permissionTimeoutMs?: number; launched?: string[] } = {}) {
  const out: ServerMessage[] = [];
  let fatal: string | undefined;
  const runtime = buildRuntime(Config.parse({}), {
    env: {},
    launcher: async (a) => void opts.launched?.push(a),
  });
  const server = new SidecarServer({
    token: "secret",
    send: (m) => out.push(m),
    bus: new EventBus(),
    createOrchestrator: runtime.createOrchestrator,
    info: { models: runtime.models, offline: runtime.offline },
    permissionTimeoutMs: opts.permissionTimeoutMs,
    onFatal: (r) => (fatal = r),
  });
  const send = (m: unknown) => server.handleLine(JSON.stringify(m));
  const hello = () => send({ type: "hello", token: "secret", protocol: 1 });
  const events = () => out.flatMap((m) => (m.type === "event" ? [m.event] : []));
  return { server, out, send, hello, events, fatal: () => fatal };
}

describe("SidecarServer handshake", () => {
  it("accepts the right token and reports honest offline info", () => {
    const h = harness();
    h.hello();
    expect(h.out[0]).toMatchObject({ type: "hello.ok", offline: true, models: ["offline-echo"] });
  });

  it("rejects a wrong token, goes fatal and ignores everything afterwards", () => {
    const h = harness();
    h.send({ type: "hello", token: "nope", protocol: 1 });
    expect(h.out[0]).toMatchObject({ type: "hello.error" });
    expect(h.fatal()).toBeDefined();
    h.send({ type: "hello", token: "secret", protocol: 1 });
    expect(h.out).toHaveLength(1);
  });

  it("rejects any non-hello message before authentication", async () => {
    const h = harness();
    h.send({ type: "task.submit", input: "qué hora es?" });
    expect(h.out[0]).toMatchObject({ type: "hello.error" });
    await h.server.idle();
    expect(h.events()).toHaveLength(0);
  });
});

describe("SidecarServer tasks", () => {
  it("runs a local intent and streams validated events", async () => {
    const launched: string[] = [];
    const h = harness({ launched });
    h.hello();
    h.send({ type: "task.submit", input: "abre vscode" });
    await h.server.idle();
    expect(launched).toEqual(["code"]);
    expect(h.events().map((e) => e.type)).toEqual(["task.started", "intent.resolved", "tool.requested", "tool.completed", "task.finished"]);
  });

  it("runs the model path against the offline provider", async () => {
    const h = harness();
    h.hello();
    h.send({ type: "task.submit", input: "dime algo breve" });
    await h.server.idle();
    const text = h.events().flatMap((e) => (e.type === "response.delta" ? [e.text] : [])).join("");
    expect(text).toContain("offline-echo");
    expect(text).toContain("dime algo breve");
  });

  it("reports malformed input without dying", () => {
    const h = harness();
    h.hello();
    h.server.handleLine("not json");
    h.send({ type: "task.submit", input: "" });
    expect(h.out.slice(1).map((m) => m.type)).toEqual(["error", "error"]);
  });

  it("errors on an unknown permission request id", () => {
    const h = harness();
    h.hello();
    h.send({ type: "permission.answer", requestId: "zzz", granted: true });
    expect(h.out[1]).toMatchObject({ type: "error" });
  });
});
