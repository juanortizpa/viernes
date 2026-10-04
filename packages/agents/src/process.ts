import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Windows only: the target is a .cmd/.bat shim that must go through cmd.exe. */
  viaCmd: boolean;
}

/**
 * How to start a CLI on this platform. npm installs `gemini`/`claude` on Windows as .cmd shims, which Node refuses to spawn
 * without a shell. Only FIXED flags ever reach that shell; the user's text travels on stdin, so nothing typed can be interpreted.
 */
export function planSpawn(command: string, args: readonly string[], platform: NodeJS.Platform = process.platform, resolve: (cmd: string) => string | undefined = whereIs): SpawnPlan {
  if (platform !== "win32") return { file: command, args: [...args], viaCmd: false };
  const resolved = /\.(exe|cmd|bat)$/i.test(command) ? command : (resolve(command) ?? command);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    for (const a of args) if (/[&|<>^%"\r\n]/.test(a)) throw new Error(`unsafe argument for cmd.exe: ${a}`);
    return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${resolved}" ${args.join(" ")}`], viaCmd: true };
  }
  return { file: resolved, args: [...args], viaCmd: false };
}

/** First match of `where <cmd>` (Windows) — prefers .cmd/.exe over the extension-less sh script npm also installs. */
export function whereIs(command: string): string | undefined {
  const r = spawnSync("where", [command], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return undefined;
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /\.(cmd|exe|bat)$/i.test(l)) ?? lines[0];
}

/** Is the CLI installed? (Cheap check used to decide which agents are available.) */
export function isInstalled(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return whereIs(command) !== undefined;
  return spawnSync("which", [command], { encoding: "utf8" }).status === 0;
}

/** Kill the agent AND everything it started (shells, test runners). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, "SIGKILL"); // the whole process group (spawned detached)
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export interface RunLinesResult {
  code: number | null;
  stoppedBy: "exit" | "timeout" | "idle" | "cancel" | "spawn-error";
  stderrTail: string;
  spawnError?: string;
}

/** Run a CLI with `stdin` as input, calling `onLine` per stdout line; enforces total and idle timeouts and cancellation. */
export function runLines(
  plan: SpawnPlan,
  o: { cwd: string; env?: NodeJS.ProcessEnv; stdin: string; onLine: (line: string) => void; signal?: AbortSignal; timeoutMs: number; idleTimeoutMs: number },
): Promise<RunLinesResult> {
  return new Promise((resolve) => {
    let stoppedBy: RunLinesResult["stoppedBy"] = "exit";
    let stderr = "";
    let child: ChildProcess;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: o.cwd,
        env: o.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        windowsVerbatimArguments: plan.viaCmd,
      });
    } catch (e) {
      return resolve({ code: null, stoppedBy: "spawn-error", stderrTail: "", spawnError: e instanceof Error ? e.message : String(e) });
    }
    const stop = (why: RunLinesResult["stoppedBy"]): void => {
      if (stoppedBy === "exit") stoppedBy = why;
      killTree(child);
    };
    const total = setTimeout(() => stop("timeout"), o.timeoutMs);
    let idle = setTimeout(() => stop("idle"), o.idleTimeoutMs);
    const bump = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => stop("idle"), o.idleTimeoutMs);
    };
    const onAbort = (): void => stop("cancel");
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.signal?.aborted) onAbort();
    child.on("error", (e) => {
      clearTimeout(total);
      clearTimeout(idle);
      resolve({ code: null, stoppedBy: "spawn-error", stderrTail: stderr, spawnError: e.message });
    });
    createInterface({ input: child.stdout! }).on("line", (l) => {
      bump();
      o.onLine(l);
    });
    child.stderr!.on("data", (d: Buffer) => {
      bump();
      stderr = (stderr + d.toString("utf8")).slice(-3000);
    });
    child.on("close", (code) => {
      clearTimeout(total);
      clearTimeout(idle);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stoppedBy, stderrTail: stderr });
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(o.stdin);
  });
}
