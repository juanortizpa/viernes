import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "@jarvis/protocol";
import { DemoPlayer } from "./player";
import { scenarios } from "./scenarios";

const fast = { sleep: () => Promise.resolve() };
const get = (id: string) => scenarios.find((s) => s.id === id)!;

function collect(p: DemoPlayer) {
  const out: OrchestratorEvent[] = [];
  p.subscribe((e) => out.push(e));
  return out;
}

describe("DemoPlayer", () => {
  it("every scenario step is valid protocol (parse throws otherwise)", async () => {
    for (const id of ["local", "cheap"]) {
      const p = new DemoPlayer(fast);
      const out = collect(p);
      await p.play(get(id));
      expect(out.length).toBeGreaterThan(0);
      expect(out.at(-1)?.type).toBe("task.finished");
      expect(out.map((e) => e.seq)).toEqual(out.map((_, i) => i));
    }
  });

  it("local scenario never involves a model", async () => {
    const p = new DemoPlayer(fast);
    const out = collect(p);
    await p.play(get("local"));
    expect(out.some((e) => e.type === "route.decided" || e.type === "model.completed")).toBe(false);
  });

  it("pauses at permission and follows the granted branch", async () => {
    const p = new DemoPlayer(fast);
    const out = collect(p);
    const done = p.play(get("escalate"));
    await new Promise((r) => setTimeout(r, 10));
    expect(out.at(-1)?.type).toBe("permission.required");
    p.resolvePermission(true);
    await done;
    expect(out.some((e) => e.type === "permission.resolved" && e.granted)).toBe(true);
    const last = out.at(-1);
    expect(last?.type === "task.finished" && last.outcome).toBe("success");
  });

  it("follows the denied branch and cancels", async () => {
    const p = new DemoPlayer(fast);
    const out = collect(p);
    const done = p.play(get("escalate"));
    await new Promise((r) => setTimeout(r, 10));
    p.resolvePermission(false);
    await done;
    expect(out.some((e) => e.type === "tool.requested" && e.tool === "write_file")).toBe(false);
    const last = out.at(-1);
    expect(last?.type === "task.finished" && last.outcome).toBe("cancelled");
  });
});
