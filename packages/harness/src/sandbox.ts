import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Grade } from "./types";

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 4_000;

/** First fenced block (any of js/javascript/ts-less); falls back to the whole text if it looks like code. */
export function extractCode(response: string): string | undefined {
  const m = /```(?:js|javascript|mjs|node)?[^\n]*\n([\s\S]*?)```/i.exec(response);
  return m?.[1];
}

/**
 * Run model-written code plus tests under Node's permission model: no file reads outside the temp dir, no child processes,
 * no workers, no addons, empty environment, hard timeout. NOT network-isolated (Node 22 has no `--allow-net` switch), which is
 * acceptable for benchmark prompts but means this is not a general sandbox for the assistant's own tools (Phase 3 note, ADR-0013).
 */
export async function runCodeTests(code: string, tests: string): Promise<Grade> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-harness-"));
  const file = join(dir, "solution.mjs");
  try {
    await writeFile(file, `import assert from "node:assert/strict";\n${code}\n;\n${tests}\n`, "utf8");
    return await new Promise<Grade>((resolve) => {
      const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${dir}`, file], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const collect = (b: Buffer) => {
        if (out.length < MAX_OUTPUT) out += b.toString();
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        const tail = out.trim().split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300);
        if (signal === "SIGKILL") resolve({ pass: false, detail: "timeout" });
        else resolve(exitCode === 0 ? { pass: true, detail: "tests passed" } : { pass: false, detail: tail || `exit ${exitCode}` });
      });
      child.on("error", (e) => resolve({ pass: false, detail: `sandbox error: ${e.message}` }));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
