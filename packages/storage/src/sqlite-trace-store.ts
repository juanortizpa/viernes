import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { ExecutionTrace } from "@jarvis/protocol";

// Loaded via require: bundlers (Vite/vitest) do not yet recognise `node:sqlite` as a builtin.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * Durable trace store on SQLite (ADR-0007). Structurally satisfies
 * `TraceStore` from @jarvis/core, so storage does not depend on core.
 * The full trace is kept as validated JSON; hot columns are denormalized for queries.
 */
export class SqliteTraceStore {
  private readonly db: DatabaseSyncType;

  /** `path` is a file path, or ":memory:". */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS traces (
        task_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        escalations INTEGER NOT NULL,
        total_cost_usd REAL NOT NULL,
        total_latency_ms REAL NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS traces_started_at ON traces (started_at);
    `);
  }

  /** Upserts by taskId. Throws if the trace does not match the protocol schema. */
  save(trace: ExecutionTrace): void {
    const t = ExecutionTrace.parse(trace);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO traces
         (task_id, started_at, task_type, outcome, escalations, total_cost_usd, total_latency_ms, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.taskId, t.startedAt, t.taskType, t.finalOutcome, t.escalations, t.totalCostUsd, t.totalLatencyMs, JSON.stringify(t));
  }

  get(taskId: string): ExecutionTrace | undefined {
    const row = this.db.prepare("SELECT json FROM traces WHERE task_id = ?").get(taskId) as { json: string } | undefined;
    return row ? ExecutionTrace.parse(JSON.parse(row.json)) : undefined;
  }

  /** Most recent first. */
  list(limit = 100): ExecutionTrace[] {
    const rows = this.db.prepare("SELECT json FROM traces ORDER BY started_at DESC LIMIT ?").all(limit) as { json: string }[];
    return rows.map((r) => ExecutionTrace.parse(JSON.parse(r.json)));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM traces").get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
