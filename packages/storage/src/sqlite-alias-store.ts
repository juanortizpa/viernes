import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

interface Row {
  alias: string;
  command: string;
  created_at: number;
}

/** Aliases the user confirmed. Structurally satisfies `AliasStore` from @jarvis/core. */
export class SqliteAliasStore {
  private readonly db: DatabaseSyncType;

  /** `path` is a file path, or ":memory:". */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS app_aliases (
        alias TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  list(): { alias: string; command: string; createdAt: number }[] {
    const rows = this.db.prepare("SELECT alias, command, created_at FROM app_aliases ORDER BY created_at").all() as unknown as Row[];
    return rows.map((r) => ({ alias: r.alias, command: r.command, createdAt: r.created_at }));
  }

  save(a: { alias: string; command: string; createdAt: number }): void {
    this.db.prepare("INSERT OR REPLACE INTO app_aliases (alias, command, created_at) VALUES (?, ?, ?)").run(a.alias, a.command, a.createdAt);
  }

  remove(alias: string): void {
    this.db.prepare("DELETE FROM app_aliases WHERE alias = ?").run(alias);
  }

  close(): void {
    this.db.close();
  }
}
