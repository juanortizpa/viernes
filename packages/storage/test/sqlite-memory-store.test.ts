import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "../src";

describe("SqliteMemoryStore", () => {
  it("persists items, usage counters and settings across a reopen; upserts, removes and clears", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jarvis-mem-")), "memory.db");
    const a = new SqliteMemoryStore(path);
    a.save({ id: "a1", kind: "fact", text: "Mi hermana se llama Ana", createdAt: 1, uses: 0 });
    a.save({ id: "b2", kind: "preference", text: "prefiero respuestas cortas", createdAt: 2, uses: 0 });
    a.save({ id: "a1", kind: "fact", text: "Mi hermana se llama Ana", createdAt: 1, usedAt: 1_000, uses: 1 }); // upsert
    a.setMeta("memory.enabled", "0");
    a.close();

    const b = new SqliteMemoryStore(path);
    expect(b.list()).toEqual([
      { id: "a1", kind: "fact", text: "Mi hermana se llama Ana", createdAt: 1, usedAt: 1_000, uses: 1 },
      { id: "b2", kind: "preference", text: "prefiero respuestas cortas", createdAt: 2, uses: 0 }, // no usedAt key when never used
    ]);
    expect(b.getMeta("memory.enabled")).toBe("0");
    expect(b.getMeta("nope")).toBeUndefined();
    b.remove("a1");
    expect(b.list().map((i) => i.id)).toEqual(["b2"]);
    b.clear();
    expect(b.list()).toEqual([]);
    expect(b.getMeta("memory.enabled")).toBe("0"); // clearing memories keeps the on/off switch
    b.close();
  });

  it("rejects an unknown kind (the table is the last line of defence)", () => {
    const s = new SqliteMemoryStore(":memory:");
    expect(() => s.save({ id: "x", kind: "secret" as never, text: "t", createdAt: 1, uses: 0 })).toThrow();
    s.close();
  });
});
