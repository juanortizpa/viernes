import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

interface Row {
  id: string;
  kind: "fact" | "preference";
  text: string;
  created_at: number;
  used_at: number | null;
  uses: number;
}

/** What the user asked JARVIS to remember (ADR-0023). Structurally satisfies `MemoryStore` from @jarvis/core. */
export class SqliteMemoryStore {
  private readonly db: DatabaseSyncType;

  /** `path` is a file path, or ":memory:". */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('fact','preference')),
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER,
        uses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  list(): { id: string; kind: "fact" | "preference"; text: string; createdAt: number; usedAt?: number; uses: number }[] {
    const rows = this.db.prepare("SELECT id, kind, text, created_at, used_at, uses FROM memories ORDER BY created_at, id").all() as unknown as Row[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, createdAt: r.created_at, ...(r.used_at !== null ? { usedAt: r.used_at } : {}), uses: r.uses }));
  }

  save(m: { id: string; kind: "fact" | "preference"; text: string; createdAt: number; usedAt?: number; uses: number }): void {
    this.db
      .prepare("INSERT OR REPLACE INTO memories (id, kind, text, created_at, used_at, uses) VALUES (?, ?, ?, ?, ?, ?)")
      .run(m.id, m.kind, m.text, m.createdAt, m.usedAt ?? null, m.uses);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  clear(): void {
    this.db.exec("DELETE FROM memories");
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)").run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
