import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@jarvis/ipc";
import { EventBus } from "@jarvis/core";
import { SqliteMemoryStore } from "@jarvis/storage";
import { buildRuntime } from "../src/runtime";
import { Config } from "../src/config";
import { SidecarServer } from "../src/server";

function harness(config: Record<string, unknown> = {}, memoryStore?: SqliteMemoryStore) {
  const out: ServerMessage[] = [];
  const runtime = buildRuntime(Config.parse(config), { env: {}, launcher: async () => {}, ...(memoryStore ? { memoryStore } : {}) });
  const server = new SidecarServer({ token: "t", send: (m) => out.push(m), bus: new EventBus(), createOrchestrator: runtime.createOrchestrator, info: { models: runtime.models, offline: runtime.offline }, memory: runtime.memory });
  const send = (m: unknown) => server.handleLine(JSON.stringify(m));
  send({ type: "hello", token: "t", protocol: 1 });
  const run = async (input: string) => {
    const from = out.length;
    send({ type: "task.submit", input });
    await server.idle();
    return out.slice(from).flatMap((m) => (m.type === "event" ? [m.event] : []));
  };
  const memory = () => {
    send({ type: "memory.get" });
    return out.filter((m): m is Extract<ServerMessage, { type: "memory" }> => m.type === "memory").at(-1)!;
  };
  return { send, run, memory, out };
}

describe("memory through the sidecar", () => {
  it("'recuerda que…' saves, the panel sees it, and the user can forget, switch off and wipe it", async () => {
    const h = harness();
    expect(h.memory()).toMatchObject({ enabled: true, items: [] });
    const events = await h.run("Recuerda que mi gato se llama Pelusa");
    expect(events.at(-1)).toMatchObject({ type: "task.finished", outcome: "success", summary: "Anotado: mi gato se llama Pelusa" });
    expect(events.some((e) => e.type === "model.completed")).toBe(false); // no model involved

    const snap = h.memory();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]).toMatchObject({ kind: "fact", text: "mi gato se llama Pelusa", uses: 0 });

    h.send({ type: "memory.toggle", enabled: false });
    expect(h.memory().enabled).toBe(false);
    h.send({ type: "memory.toggle", enabled: true });
    h.send({ type: "memory.forget", id: snap.items[0]!.id });
    expect(h.memory().items).toEqual([]);

    await h.run("recuerda que vivo en Cali");
    await h.run("recuerda que prefiero respuestas cortas");
    expect(h.memory().items.map((i) => i.kind)).toEqual(["fact", "preference"]);
    h.send({ type: "memory.clear" });
    expect(h.memory().items).toEqual([]);
  });

  it("the offline model is told what it should know, and the UI is told that it was used", async () => {
    const h = harness();
    await h.run("recuerda que mi gato se llama Pelusa");
    const events = await h.run("cómo se llama mi gato");
    const used = events.find((e) => e.type === "context.used");
    // "recuerda que…" is a memory command, not conversation: only the memory goes in.
    expect(used).toMatchObject({ conversationTurns: 0, memories: [expect.any(String)] });
    expect(h.memory().items[0]!.uses).toBe(1);
  });

  it("conversation memory follows the config switch and idle window", async () => {
    const on = harness();
    await on.run("cuéntame un chiste corto");
    expect((await on.run("otro")).some((e) => e.type === "context.used")).toBe(true);
    expect(on.memory().conversationTurns).toBeGreaterThan(0);

    const off = harness({ memory: { conversation: { enabled: false } } });
    await off.run("cuéntame un chiste corto");
    expect((await off.run("otro")).some((e) => e.type === "context.used")).toBe(false);
  });

  it("long-term memory off by config saves nothing and says so", async () => {
    const h = harness({ memory: { longTerm: { enabled: false } } });
    const events = await h.run("recuerda que vivo en Cali");
    expect(events.at(-1)).toMatchObject({ type: "task.finished", outcome: "failure", summary: expect.stringContaining("desactivada") });
    expect(h.memory()).toMatchObject({ enabled: false, items: [] });
  });

  it("persists across a restart with the SQLite store", async () => {
    const store = new SqliteMemoryStore(":memory:");
    await harness({}, store).run("recuerda que vivo en Cali");
    expect(harness({}, store).memory().items.map((i) => i.text)).toEqual(["vivo en Cali"]);
  });
});
