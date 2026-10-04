import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

interface Row {
  id: string;
  input: string;
  response: string;
  embedding: Uint8Array;
  seen: number;
  hits: number;
  created_at: number;
  updated_at: number;
  last_used_at: number;
  model: string | null;
}

export interface StoredInstantEntry {
  id: string;
  input: string;
  response: string;
  embedding: Float32Array;
  seen: number;
  hits: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  model?: string;
}

/**
 * Durable semantic-cache entries (ADR-0015, R2). Structurally satisfies `InstantStore` from @jarvis/core.
 * Embeddings are Float32 BLOBs; the cache scans them in memory (a few thousand entries is a few MB), so no vector extension is needed yet.
 */
export class SqliteInstantStore {
  private readonly db: DatabaseSyncType;

  /** `path` is a file path, or ":memory:". */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS instant_entries (
        id TEXT PRIMARY KEY,
        input TEXT NOT NULL,
        response TEXT NOT NULL,
        embedding BLOB NOT NULL,
        seen INTEGER NOT NULL,
        hits INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        model TEXT
      );
      CREATE TABLE IF NOT EXISTS instant_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  all(): StoredInstantEntry[] {
    const rows = this.db.prepare("SELECT * FROM instant_entries").all() as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      input: r.input,
      response: r.response,
      // Copy into a fresh buffer: the BLOB's byteOffset is not guaranteed to be 4-byte aligned.
      embedding: new Float32Array(new Uint8Array(r.embedding).buffer),
      seen: r.seen,
      hits: r.hits,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastUsedAt: r.last_used_at,
      ...(r.model ? { model: r.model } : {}),
    }));
  }

  put(e: StoredInstantEntry): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO instant_entries (id, input, response, embedding, seen, hits, created_at, updated_at, last_used_at, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.input, e.response, new Uint8Array(e.embedding.buffer, e.embedding.byteOffset, e.embedding.byteLength), e.seen, e.hits, e.createdAt, e.updatedAt, e.lastUsedAt, e.model ?? null);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM instant_entries WHERE id = ?").run(id);
  }

  clear(): void {
    this.db.exec("DELETE FROM instant_entries");
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM instant_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO instant_meta (key, value) VALUES (?, ?)").run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
