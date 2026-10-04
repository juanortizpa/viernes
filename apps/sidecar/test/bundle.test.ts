import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerMessage, encodeLine } from "@jarvis/ipc";
import { SqliteTraceStore } from "@jarvis/storage";
// @ts-expect-error plain .mjs build script, no types
import { buildSidecar } from "../scripts/build.mjs";

const tmp = mkdtempSync(join(tmpdir(), "jarvis-bundle-"));
let bundle = "";
beforeAll(async () => {
  bundle = await buildSidecar(join(tmp, "sidecar.mjs"));
}, 30_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("bundled sidecar (plain node, no tsx)", () => {
  it("runs standalone and persists traces to SQLite under JARVIS_DATA_DIR", async () => {
    const dataDir = join(tmp, "data");
    const child = spawn(process.execPath, [bundle], {
      cwd: tmp, // nothing from the repo is on its resolution path
      env: { PATH: process.env.PATH, JARVIS_TOKEN: "tok", JARVIS_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const finished: string[] = [];
    const messages: ServerMessage[] = [];
    createInterface({ input: child.stdout }).on("line", (l) => {
      const m = ServerMessage.parse(JSON.parse(l));
      messages.push(m);
      if (m.type === "event" && m.event.type === "task.finished") finished.push(m.event.taskId);
    });
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 150 && !pred(); i++) await new Promise((r) => setTimeout(r, 100));
      if (!pred()) throw new Error("timeout: " + JSON.stringify(messages.map((m) => m.type)));
    };
    const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));

    child.stdin.write(encodeLine({ type: "hello", token: "tok", protocol: 1 }));
    await waitFor(() => messages.some((m) => m.type === "hello.ok"));
    child.stdin.write(encodeLine({ type: "task.submit", input: "qué hora es?" }));
    await waitFor(() => finished.length === 1);
    child.stdin.write(encodeLine({ type: "task.submit", input: "hola" }));
    await waitFor(() => finished.length === 2);
    child.stdin.end();
    expect(await exited).toBe(0);

    const store = new SqliteTraceStore(join(dataDir, "traces.db"));
    expect(store.count()).toBe(2);
    expect(store.list().map((t) => t.usedLocalIntent).sort()).toEqual([false, true]);
    expect(new Set(store.list().map((t) => t.taskId))).toEqual(new Set(finished));
    store.close();
  }, 60_000);
});
