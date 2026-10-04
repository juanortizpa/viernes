import { describe, expect, it } from "vitest";
import { EventBus, IntentRouter, MemoryTraceStore, Orchestrator, StaticRouter } from "@jarvis/core";
import { PolicyEngine } from "@jarvis/policy";
import { FakeProvider, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry, filesWrite } from "@jarvis/tools";
import type { ServerMessage } from "@jarvis/ipc";
import { SidecarServer } from "../src/server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";

const path = join(tmpdir(), `jarvis-perm-${process.pid}.txt`);

function harness(permissionTimeoutMs?: number) {
  const out: ServerMessage[] = [];
  const server = new SidecarServer({
    token: "t",
    send: (m) => out.push(m),
    bus: new EventBus(),
    info: { models: ["m"], offline: true },
    permissionTimeoutMs,
    createOrchestrator: ({ bus, askPermission }) =>
      new Orchestrator({
        bus,
        intents: new IntentRouter({
          apps: {},
          rules: [(t) => (t === "guarda" ? { route: "local", intent: "files.write", tool: "files.write", args: { path, content: "x" }, confidence: 1 } : undefined)],
        }),
        router: new StaticRouter("m"),
        providers: new ProviderRegistry().register(new FakeProvider("f", [])),
        tools: new ToolRegistry().register(filesWrite),
        policy: new PolicyEngine(),
        askPermission,
        traces: new MemoryTraceStore(),
      }),
  });
  server.handleLine(JSON.stringify({ type: "hello", token: "t", protocol: 1 }));
  const events = () => out.flatMap((m) => (m.type === "event" ? [m.event] : []));
  const requestId = () => {
    const e = events().find((x) => x.type === "permission.required");
    return e?.type === "permission.required" ? e.requestId : undefined;
  };
  return { server, events, requestId, answer: (granted: boolean) => server.handleLine(JSON.stringify({ type: "permission.answer", requestId: requestId(), granted })) };
}

describe("SidecarServer permissions", () => {
  it("runs the tool only after the user grants", async () => {
    rmSync(path, { force: true });
    const h = harness();
    h.server.handleLine(JSON.stringify({ type: "task.submit", input: "guarda" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.requestId()).toBeDefined();
    expect(existsSync(path)).toBe(false);
    h.answer(true);
    await h.server.idle();
    expect(existsSync(path)).toBe(true);
    expect(h.events().at(-1)).toMatchObject({ type: "task.finished", outcome: "success" });
    rmSync(path, { force: true });
  });

  it("denies on timeout", async () => {
    rmSync(path, { force: true });
    const h = harness(20);
    h.server.handleLine(JSON.stringify({ type: "task.submit", input: "guarda" }));
    await h.server.idle();
    expect(existsSync(path)).toBe(false);
    expect(h.events().find((e) => e.type === "permission.resolved")).toMatchObject({ granted: false });
  });

  it("cancel denies the pending prompt and finishes as cancelled", async () => {
    const h = harness();
    h.server.handleLine(JSON.stringify({ type: "task.submit", input: "guarda" }));
    await new Promise((r) => setTimeout(r, 10));
    h.server.handleLine(JSON.stringify({ type: "task.cancel" }));
    await h.server.idle();
    expect(h.events().at(-1)).toMatchObject({ type: "task.finished", outcome: "cancelled" });
  });

  it("close() on disconnect cancels pending work", async () => {
    const h = harness();
    h.server.handleLine(JSON.stringify({ type: "task.submit", input: "guarda" }));
    await new Promise((r) => setTimeout(r, 10));
    h.server.close();
    await h.server.idle();
    expect(existsSync(path)).toBe(false);
  });
});
