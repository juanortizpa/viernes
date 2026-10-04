import { describe, expect, it } from "vitest";
import { LiveClient } from "./client";
import { tauriTransport, type ChannelLike, type SidecarMessage, type TauriBridge } from "./tauri-transport";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake shell: records commands, lets the test answer `sidecar_start`/`sidecar_send` and push stdout lines. */
class FakeShell implements TauriBridge {
  calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  channels: ChannelLike[] = [];
  startError?: string;
  /** While set, `sidecar_start` stays pending until it resolves. */
  holdStart?: Promise<void>;
  sendDelays: number[] = [];
  private nextGeneration = 1;

  channel(): ChannelLike {
    const ch: ChannelLike = { onmessage: () => {} };
    this.channels.push(ch);
    return ch;
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ cmd, args });
    if (cmd === "sidecar_token") return "tok" as T;
    if (cmd === "sidecar_start") {
      await this.holdStart;
      if (this.startError) throw this.startError;
      return this.nextGeneration++ as T;
    }
    if (cmd === "sidecar_send") await new Promise((r) => setTimeout(r, this.sendDelays.shift() ?? 0));
    return undefined as T;
  }

  push(m: SidecarMessage, channel = this.channels.length - 1): void {
    this.channels[channel]!.onmessage(m);
  }

  sent(): unknown[] {
    return this.calls.filter((c) => c.cmd === "sidecar_send").map((c) => ({ generation: c.args!.generation, ...JSON.parse(String(c.args!.line)) }));
  }
}

const helloOk = JSON.stringify({ type: "hello.ok", protocol: 1, models: ["m"], offline: false, voice: true, voiceEngines: ["local"] });

async function readyClient(shell = new FakeShell()) {
  const client = new LiveClient(tauriTransport(shell));
  await client.connect();
  await tick();
  shell.push({ kind: "line", line: helloOk });
  return { shell, client };
}

describe("Tauri transport", () => {
  it("handshakes with the shell's token over the relayed stdio", async () => {
    const { shell, client } = await readyClient();
    expect(shell.calls.map((c) => c.cmd)).toEqual(["sidecar_token", "sidecar_start", "sidecar_send"]);
    expect(shell.calls[1]!.args!.onMessage).toBe(shell.channels[0]);
    expect(shell.sent()).toEqual([{ generation: 1, type: "hello", token: "tok", protocol: 1 }]);
    expect(client.status).toBe("ready");
    expect(client.info?.voice).toBe(true);
  });

  it("keeps protocol lines in order even when the shell answers out of order", async () => {
    const { shell, client } = await readyClient();
    shell.sendDelays = [30, 0];
    client.submit("abre paint");
    client.cancel();
    await new Promise((r) => setTimeout(r, 60));
    expect(shell.sent().slice(1).map((m) => (m as { type: string }).type)).toEqual(["task.submit", "task.cancel"]);
  });

  it("shows why the shell could not start the sidecar", async () => {
    const shell = new FakeShell();
    shell.startError = "no encuentro el sidecar; construye el sidecar con «pnpm --filter @jarvis/sidecar build»";
    const client = new LiveClient(tauriTransport(shell));
    await client.connect();
    await tick();
    expect(client.status).toBe("unavailable");
    expect(client.lastError).toBe(shell.startError);
  });

  it("reports the exit code when the sidecar dies", async () => {
    const { shell, client } = await readyClient();
    shell.push({ kind: "exit", code: 1 });
    expect(client.status).toBe("unavailable");
    expect(client.lastError).toBe("sidecar desconectado (terminó con código 1)");
  });

  it("a retry starts a new sidecar that the old one's late exit cannot break", async () => {
    const { shell, client } = await readyClient();
    shell.push({ kind: "exit", code: null });
    expect(client.status).toBe("unavailable");
    await client.connect();
    await tick();
    shell.push({ kind: "line", line: helloOk }, 1);
    expect(client.status).toBe("ready");
    shell.push({ kind: "exit", code: 0 }, 0); // stale channel
    expect(client.status).toBe("ready");
    client.submit("hola");
    await tick();
    expect(shell.sent().at(-1)).toMatchObject({ generation: 2, type: "task.submit" });
  });

  it("closing stops that sidecar, even if it was still starting", async () => {
    const { shell, client } = await readyClient();
    client.close();
    await tick();
    expect(shell.calls.at(-1)).toEqual({ cmd: "sidecar_stop", args: { generation: 1 } });

    const early = new FakeShell();
    let release = () => {};
    early.holdStart = new Promise((r) => (release = r));
    const c2 = new LiveClient(tauriTransport(early));
    await c2.connect(); // token fetched; sidecar_start is in flight
    c2.close();
    release();
    await tick();
    expect(early.calls.map((c) => c.cmd)).toEqual(["sidecar_token", "sidecar_start", "sidecar_stop"]);
    expect(early.sent()).toEqual([]); // never said hello to a sidecar nobody wants
  });
});
