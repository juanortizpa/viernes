import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changesSinceAgent, checkpointAfter, checkpointBefore, runCodingTask, undoAgentChanges, type CodingAgent } from "../src";

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** A repo with history, a staged-but-uncommitted edit, an untracked file and an ignored file: all things undo must respect. */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "jarvis-cp-"));
  git(d, "init", "-q");
  writeFileSync(join(d, ".gitignore"), "ignored.log\n");
  writeFileSync(join(d, "a.txt"), "a1\n");
  writeFileSync(join(d, "b.txt"), "b1\n");
  git(d, "add", ".");
  git(d, "commit", "-qm", "init");
  writeFileSync(join(d, "a.txt"), "a2-staged\n");
  git(d, "add", "a.txt");
  writeFileSync(join(d, "notes.txt"), "mine, untracked\n");
  writeFileSync(join(d, "ignored.log"), "log1\n");
  return d;
}
const read = (d: string, f: string): string | null => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : null);
/** What the agent does: edit, delete, create, and touch an ignored file. */
function agentWork(d: string): void {
  writeFileSync(join(d, "a.txt"), "agent\n");
  rmSync(join(d, "b.txt"));
  writeFileSync(join(d, "new.js"), "created\n");
  writeFileSync(join(d, "notes.txt"), "agent edited my notes\n");
  writeFileSync(join(d, "ignored.log"), "log2\n");
}

describe("agent restore points (ADR-0026)", () => {
  it("undo puts every working file back, removes created files, and never touches the index, HEAD or ignored files", () => {
    const d = repo();
    const head = git(d, "rev-parse", "HEAD");
    const staged = git(d, "diff", "--cached");
    const cp = checkpointBefore(d, "arreglá todo")!;
    expect(cp).toBeDefined();
    agentWork(d);
    checkpointAfter(cp);

    const ch = changesSinceAgent(d);
    expect(ch.available).toBe(true);
    expect(ch.files).toEqual(
      expect.arrayContaining([
        { status: "M", path: "a.txt" },
        { status: "D", path: "b.txt" },
        { status: "A", path: "new.js" },
        { status: "M", path: "notes.txt" },
      ]),
    );
    expect(ch.files).toHaveLength(4);
    expect(ch.stat).toMatch(/4 files changed/);
    expect(ch.editedSince).toEqual([]);

    const u = undoAgentChanges(d);
    expect(u).toMatchObject({ ok: true, restored: 3, removed: 1 });
    expect(read(d, "a.txt")).toBe("a2-staged\n"); // the working copy as it was, not HEAD's
    expect(read(d, "b.txt")).toBe("b1\n");
    expect(read(d, "new.js")).toBeNull();
    expect(read(d, "notes.txt")).toBe("mine, untracked\n");
    expect(read(d, "ignored.log")).toBe("log2\n"); // ignored files are out of scope, by design
    expect(git(d, "rev-parse", "HEAD")).toBe(head);
    expect(git(d, "diff", "--cached")).toBe(staged);
    expect(git(d, "branch", "--list")).not.toMatch(/jarvis/);
    // Nothing left to undo.
    expect(undoAgentChanges(d)).toEqual({ ok: false, reason: "no hay cambios de un agente para deshacer" });
  });

  it("refuses to overwrite files edited after the agent finished, unless forced", () => {
    const d = repo();
    const cp = checkpointBefore(d, "x")!;
    agentWork(d);
    checkpointAfter(cp);
    writeFileSync(join(d, "a.txt"), "the user kept working\n");
    const r = undoAgentChanges(d);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.reason).toMatch(/a\.txt/);
    expect(changesSinceAgent(d).editedSince).toEqual(["a.txt"]);
    expect(read(d, "a.txt")).toBe("the user kept working\n");
    expect(undoAgentChanges(d, { force: true })).toMatchObject({ ok: true });
    expect(read(d, "a.txt")).toBe("a2-staged\n");
  });

  it("a new run replaces the restore point; a run that never finished cannot be undone", () => {
    const d = repo();
    checkpointAfter(checkpointBefore(d, "first")!);
    writeFileSync(join(d, "a.txt"), "between runs\n");
    checkpointBefore(d, "second"); // crashed before checkpointAfter
    expect(undoAgentChanges(d)).toMatchObject({ ok: false, reason: expect.stringMatching(/no terminó/) });
  });

  it("outside git there is no restore point, and that is said plainly", () => {
    const d = mkdtempSync(join(tmpdir(), "jarvis-nogit-"));
    expect(checkpointBefore(d, "x")).toBeUndefined();
    expect(changesSinceAgent(d).available).toBe(false);
    expect(undoAgentChanges(d)).toMatchObject({ ok: false, reason: expect.stringMatching(/no está versionado/) });
  });

  it("a folder that only sits below an unrelated repository is not snapshotted (found on a machine whose home is a repo)", () => {
    const d = repo();
    const inner = join(d, "scratch");
    mkdirSync(inner);
    writeFileSync(join(inner, "x.js"), "1\n");
    expect(checkpointBefore(inner, "x")).toBeUndefined();
    expect(git(d, "for-each-ref", "refs/jarvis")).toBe("");
  });

  it("a project inside a bigger repository only snapshots and restores its own folder", () => {
    const d = repo();
    mkdirSync(join(d, "web"));
    writeFileSync(join(d, "web", "app.js"), "v1\n");
    git(d, "add", ".");
    git(d, "commit", "-qm", "web");
    const web = join(d, "web");
    const cp = checkpointBefore(web, "x")!;
    expect(cp.repo.rel).toBe("web");
    writeFileSync(join(web, "app.js"), "v2\n");
    writeFileSync(join(d, "a.txt"), "outside the project\n");
    checkpointAfter(cp);
    expect(changesSinceAgent(web).files).toEqual([{ status: "M", path: "web/app.js" }]);
    expect(undoAgentChanges(web)).toMatchObject({ ok: true, restored: 1 });
    expect(read(d, "web/app.js")).toBe("v1\n");
    expect(read(d, "a.txt")).toBe("outside the project\n");
  });

  it("restores exact bytes whatever the line-ending settings (CRLF, LF, mixed, binary) and text=auto attributes", () => {
    const d = repo();
    writeFileSync(join(d, ".gitattributes"), "* text=auto\n");
    const samples: Record<string, Buffer> = {
      "crlf.txt": Buffer.from("uno\r\ndos\r\n"),
      "lf.txt": Buffer.from("uno\ndos\n"),
      "mixed.txt": Buffer.from("uno\r\ndos\ntres\r\n"),
      "bin.dat": Buffer.from([0, 255, 13, 10, 10, 13, 1]),
    };
    for (const [f, b] of Object.entries(samples)) writeFileSync(join(d, f), b);
    // Simulate a Windows user: global autocrlf on, as on this machine.
    const prev = process.env.GIT_CONFIG_PARAMETERS;
    process.env.GIT_CONFIG_PARAMETERS = "'core.autocrlf'='true'";
    try {
      const cp = checkpointBefore(d, "x")!;
      for (const f of Object.keys(samples)) writeFileSync(join(d, f), "changed by the agent\n");
      checkpointAfter(cp);
      expect(undoAgentChanges(d)).toMatchObject({ ok: true });
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
      else process.env.GIT_CONFIG_PARAMETERS = prev;
    }
    for (const [f, b] of Object.entries(samples)) expect(readFileSync(join(d, f)).equals(b)).toBe(true);
  });

  it("runCodingTask saves the restore point around the whole chain and reports it", async () => {
    const d = repo();
    const agent: CodingAgent = { name: "gemini", run: async (o) => (agentWork(o.cwd), { ok: true, summary: "hecho", stoppedBy: "exit", touched: [] }) };
    const stages: string[] = [];
    const r = await runCodingTask({ task: "t", project: { name: "p", path: d }, agents: [agent], onProgress: (s) => stages.push(s) });
    expect(r).toMatchObject({ ok: true, undoable: true });
    expect(stages[0]).toBe("Punto de restauración guardado");
    expect(undoAgentChanges(d)).toMatchObject({ ok: true });
    const scratch: CodingAgent = { name: "gemini", run: async (o) => (writeFileSync(join(o.cwd, "s.js"), "1"), { ok: true, summary: "hecho", stoppedBy: "exit", touched: [] }) };
    const nogit = await runCodingTask({ task: "t", project: { name: "p", path: mkdtempSync(join(tmpdir(), "jarvis-nogit-")) }, agents: [scratch] });
    expect(nogit.ok).toBe(true);
    expect(nogit.undoable).toBeUndefined();
  });
});
