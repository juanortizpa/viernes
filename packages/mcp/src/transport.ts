import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** One JSON-RPC message per call; how it travels is the transport's business. */
export interface McpTransport {
  send(message: unknown): void;
  /** Registers the single consumer of incoming messages. */
  onMessage(handler: (message: unknown) => void): void;
  /** Called once when the other side goes away (process exit, closed pipe). */
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

/** How to start the server process (on Windows, `.cmd` shims go through cmd.exe with fixed arguments; see @jarvis/agents planSpawn). */
export interface SpawnPlan {
  file: string;
  args: string[];
  viaCmd: boolean;
}

/**
 * MCP stdio transport: newline-delimited JSON-RPC on the child's stdin/stdout. stderr is the server's log and is only kept as a
 * short tail for error messages. Closing kills the whole process tree (servers started with npx spawn grandchildren).
 */
export class StdioTransport implements McpTransport {
  private readonly child: ChildProcess;
  private handler: (m: unknown) => void = () => {};
  private closeHandler: (reason: string) => void = () => {};
  private closed = false;
  private stderrTail = "";

  constructor(plan: SpawnPlan, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: plan.viaCmd,
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // servers sometimes print banners on stdout; they are not protocol messages
      }
      this.handler(msg);
    });
    this.child.stderr!.on("data", (d: Buffer) => void (this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-2000)));
    this.child.stdin!.on("error", () => {});
    this.child.on("error", (e) => this.finish(`no se pudo iniciar: ${e.message}`));
    this.child.on("close", (code) => this.finish(`el servidor terminó (código ${code})${this.stderrTail ? `: ${this.stderrTail.trim().split("\n").pop()}` : ""}`));
  }

  send(message: unknown): void {
    if (this.closed) throw new Error("transport closed");
    this.child.stdin!.write(JSON.stringify(message) + "\n");
  }

  onMessage(handler: (message: unknown) => void): void {
    this.handler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.child.stdin!.end();
    killTree(this.child);
    this.finish("cerrado");
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler(reason);
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
