import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteAliasStore } from "../src";

describe("SqliteAliasStore", () => {
  it("persists across reopen, upserts and removes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jarvis-alias-")), "aliases.db");
    const a = new SqliteAliasStore(path);
    a.save({ alias: "web", command: "chrome.lnk", createdAt: 1 });
    a.save({ alias: "web", command: "edge.lnk", createdAt: 2 });
    a.save({ alias: "dibujo", command: "paint.lnk", createdAt: 3 });
    a.remove("dibujo");
    a.close();

    const b = new SqliteAliasStore(path);
    expect(b.list()).toEqual([{ alias: "web", command: "edge.lnk", createdAt: 2 }]);
    b.close();
  });
});
