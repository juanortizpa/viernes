import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ServerMessage, encodeLine } from "@jarvis/ipc";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules/tsx/dist/cli.mjs");

function start(token: string) {
  const child = spawn(process.execPath, [tsx, join(root, "src/main.ts")], {
    cwd: root,
    env: { ...process.env, JARVIS_TOKEN: token, JARVIS_CONFIG: "" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const messages: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (l) => {
    messages.push(ServerMessage.parse(JSON.parse(l)));
    waiters.splice(0).forEach((w) => w());
  });
  const until = async (pred: (m: ServerMessage[]) => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pred(messages)) {
      if (Date.now() > deadline) throw new Error("timeout waiting for messages: " + JSON.stringify(messages.map((m) => m.type)));
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  const send = (m: unknown) => child.stdin.write(encodeLine(m));
  const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  return { child, messages, until, send, exited };
}

describe("sidecar over real stdio", () => {
  it("handshakes, answers a local intent and a model prompt, then exits on stdin close", async () => {
    const s = start("tok");
    s.send({ type: "hello", token: "tok", protocol: 1 });
    await s.until((m) => m.some((x) => x.type === "hello.ok"));

    s.send({ type: "task.submit", input: "qué hora es?" });
    await s.until((m) => m.some((x) => x.type === "event" && x.event.type === "task.finished"));
    const types = s.messages.flatMap((m) => (m.type === "event" ? [m.event.type] : []));
    expect(types).toEqual(["task.started", "intent.resolved", "tool.requested", "tool.completed", "task.finished"]);

    s.send({ type: "task.submit", input: "hola" });
    await s.until((m) => m.filter((x) => x.type === "event" && x.event.type === "task.finished").length === 2);
    expect(s.messages.some((m) => m.type === "event" && m.event.type === "response.delta")).toBe(true);

    s.child.stdin.end();
    expect(await s.exited).toBe(0);
  }, 30_000);

  it("rejects a bad token and exits non-zero", async () => {
    const s = start("tok");
    s.send({ type: "hello", token: "wrong", protocol: 1 });
    await s.until((m) => m.some((x) => x.type === "hello.error"));
    expect(await s.exited).toBe(3);
  }, 30_000);
});
