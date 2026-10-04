import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAgent, GeminiCliAgent, buildPrompt, describeTool, planSpawn, runCodingTask, runVerify, type CodingAgent } from "../src";

const dir = mkdtempSync(join(tmpdir(), "jarvis-agents-"));
/** A stand-in CLI: logs argv+stdin, then behaves per MODE, emitting the REAL event shapes captured from Gemini CLI 0.62 / Claude Code. */
function fakeCli(kind: "gemini" | "claude", mode: string): string {
  const p = join(dir, `${kind}-${mode}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    p,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
appendFileSync(process.env.FAKE_LOG ?? "/dev/null", JSON.stringify({ kind: "${kind}", argv: process.argv.slice(2), stdin, trust: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? null }) + "\\n");
const out = (o) => console.log(JSON.stringify(o));
const fix = () => writeFileSync("sum.js", "function sum(a, b) {\\n  return a + b;\\n}\\nmodule.exports = { sum };\\n");
const wrong = () => writeFileSync("sum.js", "function sum(a, b) {\\n  return a * b;\\n}\\nmodule.exports = { sum };\\n");
const mode = "${mode}";
if ("${kind}" === "gemini") {
  out({ type: "init", model: "auto" });
  out({ type: "tool_use", tool_name: "read_file", tool_id: "r1", parameters: { file_path: "sum.js" } });
  if (mode === "quota") { out({ type: "result", status: "error", error: { type: "ApiError", message: "Quota exceeded for quota metric 'Requests' (429)" } }); process.exit(1); }
  out({ type: "tool_use", tool_name: "replace", tool_id: "e1", parameters: { file_path: "sum.js", old_string: "a - b", new_string: "a + b" } });
  if (mode === "wrong") wrong(); else fix();
  if (mode === "hang") { setInterval(() => {}, 1000); } else {
    out({ type: "message", role: "assistant", content: "Cambié la resta por una suma en sum.js.", delta: false });
    out({ type: "result", status: mode === "fail" ? "error" : "success", ...(mode === "fail" ? { error: { message: "boom" } } : {}) });
    process.exit(mode === "fail" ? 1 : 0);
  }
} else {
  out({ type: "system", subtype: "init" });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: process.cwd() + "/sum.js" } }] } });
  if (mode === "limit") { out({ type: "result", subtype: "error", is_error: true, result: "Claude AI usage limit reached" }); process.exit(1); }
  fix();
  out({ type: "assistant", message: { content: [{ type: "text", text: "Arreglé sum.js: ahora suma." }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "Arreglé sum.js: ahora suma." });
}
`,
  );
  chmodSync(p, 0o755);
  return asExecutable(p);
}
/** Windows cannot run a script directly: wrap it in a .cmd shim, as npm does for the real CLIs (this exercises the cmd.exe path). */
function asExecutable(script: string): string {
  if (process.platform !== "win32") return script;
  const shim = script.replace(/\.mjs$/, ".cmd");
  writeFileSync(shim, `@node "${script}" %*\r\n`);
  return shim;
}
function project(): { path: string; log: string } {
  const p = mkdtempSync(join(dir, "proj-"));
  writeFileSync(join(p, "sum.js"), "function sum(a, b) {\n  return a - b;\n}\nmodule.exports = { sum };\n");
  writeFileSync(join(p, "test.js"), 'const { sum } = require("./sum");\nif (sum(2, 3) !== 5) { console.error("FAIL", sum(2, 3)); process.exit(1); }\n');
  const log = join(p, "..", `${basename(p)}.log`);
  process.env.FAKE_LOG = log;
  return { path: p, log };
}
const calls = (log: string) => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string; argv: string[]; stdin: string; trust: string | null });

describe("planSpawn", () => {
  it("runs directly off Windows; on Windows, .cmd shims go through cmd.exe with only fixed flags", () => {
    expect(planSpawn("gemini", ["-o", "stream-json"], "linux")).toEqual({ file: "gemini", args: ["-o", "stream-json"], viaCmd: false });
    expect(planSpawn("gemini", ["-o", "stream-json"], "win32", () => "C:\\npm\\gemini.cmd")).toEqual({ file: "cmd.exe", args: ["/d", "/s", "/c", '"C:\\npm\\gemini.cmd" -o stream-json'], viaCmd: true });
    expect(planSpawn("claude", ["-p"], "win32", () => "C:\\bin\\claude.exe")).toEqual({ file: "C:\\bin\\claude.exe", args: ["-p"], viaCmd: false });
    expect(() => planSpawn("gemini", ["-m", "x & del *"], "win32", () => "C:\\g.cmd")).toThrow(/unsafe/);
  });
});

describe("describeTool", () => {
  it("turns both CLIs' tool calls into short Spanish progress lines", () => {
    expect(describeTool("replace", { file_path: "src/sum.js" })).toEqual({ stage: "Editando sum.js", file: "src/sum.js" });
    expect(describeTool("Edit", { file_path: "C:\\p\\app.ts" }).stage).toBe("Editando app.ts");
    expect(describeTool("Bash", { command: "pnpm test" }).stage).toBe("Ejecutando pnpm test");
    expect(describeTool("read_file", { file_path: "a.ts" }).stage).toBe("Leyendo a.ts");
    expect(describeTool("weird_tool").stage).toBe("Usando weird_tool");
  });
});

describe("GeminiCliAgent (real event shapes)", () => {
  it("sends the task on stdin (never argv), trusts only this run's folder, streams progress and reports the summary", async () => {
    const pr = project();
    const stages: string[] = [];
    const r = await new GeminiCliAgent({ binary: fakeCli("gemini", "ok") }).run({ prompt: "TAREA: arreglá sum.js; rm -rf / && echo hacked", cwd: pr.path, onProgress: (s) => stages.push(s) });
    expect(r).toMatchObject({ ok: true, stoppedBy: "exit", summary: "Cambié la resta por una suma en sum.js.", touched: ["sum.js"] });
    expect(stages).toEqual(["Leyendo sum.js", "Editando sum.js"]);
    const c = calls(pr.log)[0]!;
    expect(c.stdin).toContain("rm -rf /");
    expect(c.argv.join(" ")).not.toMatch(/TAREA|rm -rf/);
    expect(c.argv).toEqual(["-o", "stream-json", "--approval-mode", "auto_edit"]);
    expect(c.trust).toBe("true");
  });

  it("reports an error result, flags quota errors as limits, and a missing binary clearly", async () => {
    const pr = project();
    expect(await new GeminiCliAgent({ binary: fakeCli("gemini", "fail") }).run({ prompt: "x", cwd: pr.path })).toMatchObject({ ok: false, failure: "boom" });
    expect(await new GeminiCliAgent({ binary: fakeCli("gemini", "quota") }).run({ prompt: "x", cwd: pr.path })).toMatchObject({ ok: false, limited: true });
    const missing = await new GeminiCliAgent({ binary: join(dir, "nope") }).run({ prompt: "x", cwd: pr.path });
    expect(missing.stoppedBy).toBe("spawn-error");
    expect(missing.failure).toMatch(/gemini-cli/);
  });

  it("kills an agent that goes silent (stuck retrying), and cancels on request", async () => {
    const pr = project();
    const t0 = Date.now();
    const r = await new GeminiCliAgent({ binary: fakeCli("gemini", "hang") }).run({ prompt: "x", cwd: pr.path, idleTimeoutMs: 400 });
    expect(r).toMatchObject({ ok: false, stoppedBy: "idle" });
    expect(Date.now() - t0).toBeLessThan(3000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    expect(await new GeminiCliAgent({ binary: fakeCli("gemini", "hang") }).run({ prompt: "x", cwd: pr.path, signal: ac.signal })).toMatchObject({ stoppedBy: "cancel", failure: "cancelado" });
  });
});

describe("ClaudeCodeAgent (real event shapes)", () => {
  it("parses assistant/tool_use/result and recognises the plan's usage limit", async () => {
    const pr = project();
    const stages: string[] = [];
    expect(await new ClaudeCodeAgent({ binary: fakeCli("claude", "ok") }).run({ prompt: "x", cwd: pr.path, onProgress: (s) => stages.push(s) })).toMatchObject({ ok: true, summary: "Arreglé sum.js: ahora suma." });
    expect(stages).toEqual(["Editando sum.js"]);
    expect(calls(pr.log)[0]!.argv).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]);
    expect(await new ClaudeCodeAgent({ binary: fakeCli("claude", "limit") }).run({ prompt: "x", cwd: pr.path })).toMatchObject({ ok: false, limited: true });
  });
});

describe("runCodingTask: cheapest first, the project's own check decides, escalate with context", () => {
  const gem = (mode: string) => new GeminiCliAgent({ binary: fakeCli("gemini", mode) });
  const cla = (mode: string) => new ClaudeCodeAgent({ binary: fakeCli("claude", mode) });

  it("Gemini fixes it and the check passes: Claude Code is never called", async () => {
    const pr = project();
    const r = await runCodingTask({ task: "arreglá sum", project: { name: "demo", path: pr.path, verify: "node test.js" }, agents: [gem("ok"), cla("ok")] });
    expect(r).toMatchObject({ ok: true, agent: "gemini", attempts: [{ agent: "gemini", ok: true, verified: true }] });
    expect(calls(pr.log).map((c) => c.kind)).toEqual(["gemini"]);
  });

  it("Gemini's edit does not pass the check: escalates to Claude Code, which is told what failed and continues from the files", async () => {
    const pr = project();
    const stages: string[] = [];
    const r = await runCodingTask({ task: "arreglá sum", project: { name: "demo", path: pr.path, verify: "node test.js" }, agents: [gem("wrong"), cla("ok")], onProgress: (s) => stages.push(s) });
    expect(r).toMatchObject({ ok: true, agent: "claude", attempts: [{ agent: "gemini", ok: false, verified: false }, { agent: "claude", ok: true, verified: true }] });
    const claudeCall = calls(pr.log)[1]!;
    expect(claudeCall.stdin).toMatch(/Otro asistente \(gemini\) ya lo intentó.*la comprobación falló/s);
    expect(claudeCall.stdin).toContain("FAIL 6");
    expect(stages).toContain("Claude Code: empezando");
    expect(readFileSync(join(pr.path, "sum.js"), "utf8")).toContain("a + b");
  });

  it("an agent stuck AFTER doing the work still counts: the check runs even after the idle kill", async () => {
    const pr = project();
    const r = await runCodingTask({ task: "arreglá sum", project: { name: "demo", path: pr.path, verify: "node test.js" }, agents: [gem("hang"), cla("ok")], idleTimeoutMs: 400 });
    expect(r).toMatchObject({ ok: true, agent: "gemini" });
    expect(calls(pr.log).map((c) => c.kind)).toEqual(["gemini"]);
  });

  it("quota exhausted -> next agent; nobody succeeds -> clear failure; without a check the agent's own result decides", async () => {
    const pr = project();
    expect(await runCodingTask({ task: "x", project: { name: "d", path: pr.path }, agents: [gem("quota"), cla("ok")] })).toMatchObject({ ok: true, agent: "claude" });
    const pr2 = project();
    const r = await runCodingTask({ task: "x", project: { name: "d", path: pr2.path }, agents: [gem("fail"), cla("limit")] });
    expect(r.ok).toBe(false);
    expect(r.attempts.map((a) => a.agent)).toEqual(["gemini", "claude"]);
    expect((await runCodingTask({ task: "x", project: { name: "d", path: pr2.path }, agents: [] })).summary).toMatch(/instalá Gemini CLI o Claude Code/);
  });

  it("cancellation stops at once and does not escalate", async () => {
    const pr = project();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runCodingTask({ task: "x", project: { name: "d", path: pr.path, verify: "node test.js" }, agents: [gem("hang"), cla("ok")], signal: ac.signal });
    expect(r).toMatchObject({ ok: false, summary: "Cancelado." });
    expect(calls(pr.log).map((c) => c.kind)).toEqual(["gemini"]);
  });
});

describe("runVerify / buildPrompt", () => {
  it("the check's exit code is the verdict, with the output tail for the next agent", async () => {
    expect(await runVerify('node -e "console.log(1)"', dir)).toMatchObject({ ok: true });
    const bad = await runVerify('node -e "console.error(\'nope\'); process.exit(2)"', dir);
    expect(bad).toMatchObject({ ok: false });
    expect(bad.outputTail).toContain("nope");
  });
  it("tells the agent the boundaries", () => {
    const p = buildPrompt("arreglá el login", { name: "web", path: "/x", verify: "pnpm test" });
    expect(p).toMatch(/proyecto «web»/);
    expect(p).toMatch(/no hagas commits, push/);
    expect(p).toMatch(/pnpm test/);
    expect(p).toMatch(/respondé en español/);
  });
});
