import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionTrace } from "@jarvis/protocol";
import { SqliteTraceStore } from "../src";

const trace = (taskId: string, startedAt: number, extra: Partial<ExecutionTrace> = {}): ExecutionTrace => ({
  taskId,
  startedAt,
  taskType: "qa_simple",
  inputTokensEstimate: 10,
  usedLocalIntent: true,
  attempts: [],
  escalations: 0,
  finalOutcome: "success",
  userIntervened: false,
  totalCostUsd: 0.001,
  totalLatencyMs: 12,
  ...extra,
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("SqliteTraceStore", () => {
  it("round-trips a trace and lists newest first", () => {
    const s = new SqliteTraceStore(":memory:");
    s.save(trace("a", 1));
    s.save(trace("b", 2, { finalOutcome: "failure" }));
    expect(s.get("b")?.finalOutcome).toBe("failure");
    expect(s.list().map((t) => t.taskId)).toEqual(["b", "a"]);
    expect(s.count()).toBe(2);
    expect(s.get("missing")).toBeUndefined();
  });

  it("upserts by taskId", () => {
    const s = new SqliteTraceStore(":memory:");
    s.save(trace("a", 1));
    s.save(trace("a", 1, { finalOutcome: "cancelled" }));
    expect(s.count()).toBe(1);
    expect(s.get("a")?.finalOutcome).toBe("cancelled");
  });

  it("rejects traces that violate the protocol schema", () => {
    const s = new SqliteTraceStore(":memory:");
    expect(() => s.save({ ...trace("x", 1), totalCostUsd: -1 })).toThrow();
    expect(s.count()).toBe(0);
  });

  it("persists across reopen and creates missing directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-"));
    dirs.push(dir);
    const path = join(dir, "nested", "traces.db");
    const a = new SqliteTraceStore(path);
    a.save(trace("a", 1));
    a.close();
    const b = new SqliteTraceStore(path);
    expect(b.get("a")?.taskId).toBe("a");
    b.close();
  });
});
