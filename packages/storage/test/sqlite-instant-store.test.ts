import { describe, expect, it } from "vitest";
import { SqliteInstantStore } from "../src";

describe("SqliteInstantStore", () => {
  it("round-trips entries, embeddings (Float32) and meta", () => {
    const s = new SqliteInstantStore(":memory:");
    const embedding = Float32Array.from({ length: 8 }, (_, i) => i / 10);
    s.put({ id: "a", input: "q", response: "r", embedding, seen: 2, hits: 1, createdAt: 1, updatedAt: 2, lastUsedAt: 3, model: "m" });
    const [e] = s.all();
    expect(e).toMatchObject({ id: "a", input: "q", response: "r", seen: 2, hits: 1, createdAt: 1, updatedAt: 2, lastUsedAt: 3, model: "m" });
    expect([...e!.embedding]).toEqual([...embedding]);
    s.setMeta("enabled", "0");
    expect(s.getMeta("enabled")).toBe("0");
    s.remove("a");
    expect(s.all()).toEqual([]);
  });
});
