import { describe, expect, it } from "vitest";
import { MemoryAuditLog, PolicyEngine, TaintTracker } from "../src";

const req = (risk: "read" | "reversible" | "sensitive" | "critical", tainted = false, tool = "t") => ({
  taskId: "task1",
  tool,
  risk,
  tainted,
});

describe("PolicyEngine", () => {
  it("allows read and reversible when clean", () => {
    const p = new PolicyEngine();
    expect(p.decide(req("read")).action).toBe("allow");
    expect(p.decide(req("reversible")).action).toBe("allow");
  });

  it("requires confirmation for sensitive and critical", () => {
    const p = new PolicyEngine();
    expect(p.decide(req("sensitive")).action).toBe("confirm");
    expect(p.decide(req("critical")).action).toBe("confirm");
  });

  it("allowSensitive pre-approves sensitive only when clean, never critical", () => {
    const p = new PolicyEngine({ allowSensitive: new Set(["t"]) });
    expect(p.decide(req("sensitive")).action).toBe("allow");
    expect(p.decide(req("sensitive", true)).action).toBe("confirm");
    expect(p.decide(req("critical")).action).toBe("confirm");
  });

  it("taint does not block read actions", () => {
    expect(new PolicyEngine().decide(req("read", true)).action).toBe("allow");
  });

  it("deny list wins over everything", () => {
    const p = new PolicyEngine({ denyTools: new Set(["t"]), allowSensitive: new Set(["t"]) });
    expect(p.decide(req("read")).action).toBe("deny");
  });

  it("audits every decision and grant", () => {
    const log = new MemoryAuditLog();
    const p = new PolicyEngine({ now: () => 7 }, log);
    p.decide(req("sensitive"));
    p.recordGrant(req("sensitive"), false);
    expect(log.entries).toHaveLength(2);
    expect(log.entries[1]).toMatchObject({ ts: 7, granted: false });
  });
});

describe("TaintTracker", () => {
  it("only untrusted_external taints, and stays tainted", () => {
    const t = new TaintTracker();
    t.observe("user");
    t.observe("tool_trusted");
    expect(t.isTainted).toBe(false);
    t.observe("untrusted_external");
    t.observe("user");
    expect(t.isTainted).toBe(true);
  });
});
