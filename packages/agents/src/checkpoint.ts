import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Restore points for coding-agent runs (ADR-0026), like Claude Code's rewind but kept in the project's own git store:
 * - A snapshot is a tree of the project's WORKING FILES (tracked + untracked, honouring .gitignore), hashed byte for byte with
 *   `--no-filters` into a throw-away index: no CRLF conversion, no LFS/clean filters, and the user's index, branches and HEAD are
 *   never touched.
 * - It covers only the project folder (a project inside a bigger repo — or a home folder that happens to be a repo — is not
 *   snapshotted beyond itself), and only if that folder is really versioned.
 * - It is pinned under refs/jarvis/* so `git gc` keeps it and it survives restarts.
 * - Undo refuses when files changed after the agent finished (the user's own edits are never overwritten).
 */
interface GitOut {
  ok: boolean;
  out: string;
  err: string;
}

/** Plain git, with every conversion that could alter bytes switched off. */
function git(cwd: string, args: string[], o: { env?: NodeJS.ProcessEnv; input?: string | Buffer } = {}): GitOut {
  const r = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.quotepath=off", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: o.env ?? process.env,
    input: o.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\s+$/, ""), err: (r.stderr ?? "").trim() || (r.error?.message ?? "") };
}

function gitBytes(cwd: string, args: string[]): Buffer {
  const r = spawnSync("git", args, { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} falló: ${r.stderr?.toString().trim()}`);
  return r.stdout;
}

export interface ProjectRepo {
  /** Top of the git work tree. */
  root: string;
  /** Project folder relative to `root`, "/"-separated; "." when the project IS the repository. */
  rel: string;
}

/**
 * The repository that versions this project, or undefined. A folder that merely sits somewhere below an unrelated repository (a
 * temp folder under a versioned home directory) does not count: it must be the repo root or contain tracked files.
 */
export function projectRepo(cwd: string): ProjectRepo | undefined {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return undefined;
  const root = resolve(top.out);
  const rel = relative(root, resolve(cwd)).split(sep).join("/") || ".";
  if (rel.startsWith("..")) return undefined;
  if (rel !== ".") {
    const tracked = git(root, ["ls-files", "--cached", "-z", "--", rel]);
    if (!tracked.ok || !tracked.out) return undefined;
  }
  return { root, rel };
}

/** refs/jarvis/agent/<project-id>-{before,after}: one restore point per project, even several projects in one repository. */
const refs = (p: ProjectRepo): { before: string; after: string } => {
  const id = p.rel === "." ? "root" : createHash("sha1").update(p.rel).digest("hex").slice(0, 12);
  return { before: `refs/jarvis/agent/${id}-before`, after: `refs/jarvis/agent/${id}-after` };
};

/** Tree id of the project's current working files (tracked + untracked, minus ignored), hashed without any git filter. */
export function snapshotTree(p: ProjectRepo): string {
  const list = git(p.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", p.rel]);
  if (!list.ok) throw new Error(`git ls-files falló: ${list.err}`);
  // --cached also lists tracked files that were deleted from disk, and submodule folders: keep regular files that exist.
  const files = [...new Set(list.out.split("\0").filter(Boolean))].filter((f) => !/[\r\n]/.test(f)).filter((f) => {
    try {
      return statSync(join(p.root, f)).isFile();
    } catch {
      return false;
    }
  });
  const index = join(tmpdir(), `jarvis-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    if (files.length) {
      const hashed = git(p.root, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: files.join("\n") + "\n" });
      if (!hashed.ok) throw new Error(`git hash-object falló: ${hashed.err}`);
      const shas = hashed.out.split("\n");
      if (shas.length !== files.length) throw new Error("git hash-object devolvió una lista incompleta");
      const entries = files.map((f, i) => `${executable(join(p.root, f)) ? "100755" : "100644"} ${shas[i]}\t${f}`).join("\0") + "\0";
      const upd = git(p.root, ["update-index", "--add", "-z", "--index-info"], { env, input: entries });
      if (!upd.ok) throw new Error(`git update-index falló: ${upd.err}`);
    }
    const tree = git(p.root, ["write-tree"], { env });
    if (!tree.ok || !tree.out) throw new Error(`git write-tree falló: ${tree.err}`);
    return tree.out;
  } finally {
    rmSync(index, { force: true });
  }
}

const executable = (path: string): boolean => process.platform !== "win32" && (statSync(path).mode & 0o111) !== 0;

/** Pins a tree under `ref` as a commit object (parented on HEAD when there is one). Branches are not moved. */
function pin(root: string, ref: string, tree: string, message: string): void {
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const env = { ...process.env, GIT_AUTHOR_NAME: "JARVIS", GIT_AUTHOR_EMAIL: "jarvis@localhost", GIT_COMMITTER_NAME: "JARVIS", GIT_COMMITTER_EMAIL: "jarvis@localhost" };
  const commit = git(root, ["commit-tree", tree, ...(head.ok && head.out ? ["-p", head.out] : []), "-m", message], { env });
  if (!commit.ok) throw new Error(`git commit-tree falló: ${commit.err}`);
  const upd = git(root, ["update-ref", ref, commit.out]);
  if (!upd.ok) throw new Error(`git update-ref falló: ${upd.err}`);
}

function refTree(root: string, ref: string): string | undefined {
  const r = git(root, ["rev-parse", "--verify", "-q", `${ref}^{tree}`]);
  return r.ok && r.out ? r.out : undefined;
}

export interface AgentCheckpoint {
  repo: ProjectRepo;
  tree: string;
}

/** Before an agent runs. Undefined when the folder is not versioned with git (then there is no undo). */
export function checkpointBefore(cwd: string, task: string): AgentCheckpoint | undefined {
  const repo = projectRepo(cwd);
  if (!repo) return undefined;
  const r = refs(repo);
  const tree = snapshotTree(repo);
  pin(repo.root, r.before, tree, `jarvis: antes de «${task.slice(0, 200)}»`);
  git(repo.root, ["update-ref", "-d", r.after]); // a stale "after" of an earlier run must never validate this one's undo
  return { repo, tree };
}

/** After the agent (and verification) finished: what undo will compare against. */
export function checkpointAfter(cp: AgentCheckpoint): void {
  pin(cp.repo.root, refs(cp.repo).after, snapshotTree(cp.repo), "jarvis: después del agente");
}

export interface FileChange {
  status: "A" | "M" | "D";
  /** Relative to the repository root, "/"-separated. */
  path: string;
}

function diffTrees(root: string, a: string, b: string): FileChange[] {
  const r = git(root, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", a, b]);
  if (!r.ok) throw new Error(`git diff-tree falló: ${r.err}`);
  const parts = r.out.split("\0").filter(Boolean);
  const out: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i]![0];
    out.push({ status: s === "A" || s === "D" ? s : "M", path: parts[i + 1]! }); // type changes count as modifications
  }
  return out;
}

export interface ChangesReport {
  /** Whether a restore point from the last agent run exists. */
  available: boolean;
  /** Files that differ now from the moment before the last agent run. */
  files: FileChange[];
  /** `git diff --stat` between the restore point and now. */
  stat: string;
  /** Files edited after the agent finished (by the user or another program): undo would not touch them blindly. */
  editedSince: string[];
}

/** What changed since the last agent run started (the agent's work, plus anything after it). */
export function changesSinceAgent(cwd: string): ChangesReport {
  const repo = projectRepo(cwd);
  const r = repo ? refs(repo) : undefined;
  const before = repo && r ? refTree(repo.root, r.before) : undefined;
  if (!repo || !r || !before) return { available: false, files: [], stat: "", editedSince: [] };
  const now = snapshotTree(repo);
  const after = refTree(repo.root, r.after);
  const stat = git(repo.root, ["diff", "--no-renames", "--stat", "--no-color", before, now]);
  return {
    available: true,
    files: diffTrees(repo.root, before, now),
    stat: stat.ok ? stat.out.trim() : "",
    editedSince: after && after !== now ? diffTrees(repo.root, after, now).map((f) => f.path) : [],
  };
}

export type UndoResult = { ok: true; restored: number; removed: number; files: FileChange[] } | { ok: false; reason: string };

/**
 * Puts the project's files back exactly as they were before the last agent run. Refuses when there is no restore point, when the
 * run has not finished, or when files changed after it (unless `force`). Files the agent created are removed; untouched files are
 * not rewritten.
 */
export function undoAgentChanges(cwd: string, o: { force?: boolean } = {}): UndoResult {
  const repo = projectRepo(cwd);
  if (!repo) return { ok: false, reason: "el proyecto no está versionado con git: no hay punto de restauración" };
  const r = refs(repo);
  const before = refTree(repo.root, r.before);
  if (!before) return { ok: false, reason: "no hay cambios de un agente para deshacer" };
  const after = refTree(repo.root, r.after);
  if (!after) return { ok: false, reason: "el último trabajo del agente no terminó de registrarse; no deshago a ciegas" };
  const now = snapshotTree(repo);
  const since = after !== now ? diffTrees(repo.root, after, now) : [];
  if (since.length > 0 && !o.force) {
    return { ok: false, reason: `hay archivos que cambiaron después del agente (${since.slice(0, 5).map((f) => f.path).join(", ")}${since.length > 5 ? "…" : ""}); no los piso` };
  }
  const files = diffTrees(repo.root, before, now);
  const blobs = new Map<string, { mode: string; sha: string }>();
  if (files.some((f) => f.status !== "A")) {
    const ls = git(repo.root, ["ls-tree", "-r", "-z", before]);
    if (!ls.ok) throw new Error(`git ls-tree falló: ${ls.err}`);
    for (const entry of ls.out.split("\0").filter(Boolean)) {
      const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
      if (m) blobs.set(m[3]!, { mode: m[1]!, sha: m[2]! });
    }
  }
  const inside = (p: string): string => {
    const abs = resolve(repo.root, p);
    if (!abs.startsWith(repo.root + sep)) throw new Error(`ruta fuera del repositorio: ${p}`); // paths come from git; still, never step outside
    return abs;
  };
  let restored = 0;
  let removed = 0;
  for (const f of files) {
    const abs = inside(f.path);
    if (f.status === "A") {
      rmSync(abs, { force: true });
      removed++;
      continue;
    }
    const b = blobs.get(f.path);
    if (!b) throw new Error(`no encuentro ${f.path} en el punto de restauración`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, gitBytes(repo.root, ["cat-file", "blob", b.sha])); // exact bytes, no smudge filter, no EOL conversion
    if (process.platform !== "win32") chmodSync(abs, b.mode === "100755" ? 0o755 : 0o644);
    restored++;
  }
  git(repo.root, ["update-ref", "-d", r.after]);
  git(repo.root, ["update-ref", "-d", r.before]);
  return { ok: true, restored, removed, files };
}

/** Whether `cwd` has a pending restore point (cheap; no snapshot). */
export function hasRestorePoint(cwd: string): boolean {
  const repo = projectRepo(cwd);
  return repo !== undefined && existsSync(repo.root) && refTree(repo.root, refs(repo).before) !== undefined;
}
