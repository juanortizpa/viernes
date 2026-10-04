import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry, filesRead, filesWrite, makeAppsOpen, timeNow } from "../src";

const ctx = { taskId: "t" };

describe("ToolRegistry", () => {
  it("rejects duplicates and describes tools with JSON schema", () => {
    const r = new ToolRegistry().register(filesWrite);
    expect(() => r.register(filesWrite)).toThrow();
    const [d] = r.list();
    expect(d).toMatchObject({ name: "files.write", risk: "sensitive", reversible: true, verifiable: true });
    expect(d?.inputSchema).toMatchObject({ type: "object", required: ["path", "content"] });
  });

  it("marks tools without verify as not verifiable", () => {
    expect(new ToolRegistry().register(timeNow).list()[0]?.verifiable).toBe(false);
  });
});

describe("built-in tools", () => {
  it("files.write then files.read round-trips, read is untrusted, write verifies", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "jarvis-")), "a", "note.txt");
    const w = await filesWrite.run({ path, content: "hola" }, ctx);
    expect(w.ok).toBe(true);
    expect(await filesWrite.verify!({ path, content: "hola" }, w, ctx)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("hola");
    const r = await filesRead.run({ path }, ctx);
    expect(r).toMatchObject({ ok: true, output: "hola", provenance: "untrusted_external" });
  });

  it("files.read reports failure instead of throwing", async () => {
    const r = await filesRead.run({ path: "/nonexistent/x" }, ctx);
    expect(r.ok).toBe(false);
  });

  it("apps.open uses the injected launcher and reports its failure", async () => {
    const opened: string[] = [];
    expect((await makeAppsOpen(async (a) => void opened.push(a)).run({ app: "code" }, ctx)).ok).toBe(true);
    expect(opened).toEqual(["code"]);
    const bad = makeAppsOpen(async () => {
      throw new Error("nope");
    });
    expect((await bad.run({ app: "x" }, ctx)).ok).toBe(false);
  });
});
