import { describe, expect, it } from "vitest";
import { EvalTask } from "../src/types";
import { grade } from "../src/checks";
import { seedSuite } from "../src/suites/seed";

describe("seed suite ground truth", () => {
  it("is schema-valid with unique ids", () => {
    for (const t of seedSuite) EvalTask.parse(t);
    expect(new Set(seedSuite.map((t) => t.id)).size).toBe(seedSuite.length);
    expect(seedSuite.length).toBeGreaterThanOrEqual(40);
  });

  it("every task's reference answer passes its own check", async () => {
    for (const t of seedSuite) {
      const g = await grade(t, t.reference);
      expect(g, `${t.id}: ${g.detail}`).toMatchObject({ pass: true });
    }
  }, 120_000);

  it("a non-answer fails every check", async () => {
    for (const t of seedSuite) expect((await grade(t, "No lo sé, lo siento.")).pass, t.id).toBe(false);
    for (const t of seedSuite.filter((t) => t.check.kind === "code_tests")) {
      expect((await grade(t, "```js\n// empty\n```")).pass, t.id).toBe(false);
    }
  }, 120_000);
});

describe("grade", () => {
  it("handles formatting noise", async () => {
    const exact = { check: { kind: "exact" as const, answer: "Canberra" } };
    expect((await grade(exact, "**Canberra**.")).pass).toBe(true);
    expect((await grade(exact, "Pienso... la capital es\nCanberra")).pass).toBe(true);
    expect((await grade(exact, "<think>Sydney? no</think>Canberra")).pass).toBe(true);
    expect((await grade(exact, "Sydney")).pass).toBe(false);
    const num = { check: { kind: "number" as const, value: 1234, tolerance: 0 } };
    expect((await grade(num, "El resultado es 1,234")).pass).toBe(true);
    expect((await grade(num, "x = 1000, resultado 1234.")).pass).toBe(true);
    expect((await grade(num, "1233")).pass).toBe(false);
  });

  it("sandbox: times out, cannot read files or spawn processes", async () => {
    const t = (tests: string) => ({ check: { kind: "code_tests" as const, tests } });
    expect((await grade(t("while(true){}"), "```js\n1\n```")).detail).toBe("timeout");
    const read = await grade(t(`import { readFileSync } from "node:fs"; readFileSync("/etc/passwd");`), "```js\n1\n```");
    expect(read.pass).toBe(false);
    const exec = await grade(t(`const { execSync } = await import("node:child_process"); execSync("echo hi");`), "```js\n1\n```");
    expect(exec.pass).toBe(false);
  }, 60_000);
});
