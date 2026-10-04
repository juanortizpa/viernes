import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@jarvis/protocol";
import { PolicyEngine } from "@jarvis/policy";
import { FakeProvider, ProviderRegistry } from "@jarvis/providers";
import { ToolRegistry, makeAliasesForget, makeAliasesLearn, makeAliasesList, makeAppsOpen } from "@jarvis/tools";
import { AppCatalog, EventBus, IntentRouter, MemoryAliasStore, MemoryTraceStore, Orchestrator, StaticRouter } from "../src";

const catalog = () => {
  const c = new AppCatalog();
  c.add("vs code", "code", "config");
  c.add("Google Chrome", "C:\\Menu\\Google Chrome.lnk", "scan");
  c.add("Paint", "C:\\Menu\\Paint.lnk", "scan");
  c.add("OneNote", "C:\\Menu\\OneNote.lnk", "scan");
  c.add("Notepad++", "C:\\Menu\\Notepad++.lnk", "scan");
  return c;
};

describe("AppCatalog", () => {
  it("never lets a lower-priority source overwrite a higher one", () => {
    const c = new AppCatalog();
    expect(c.add("x", "cfg", "config")).toBe(true);
    expect(c.add("x", "scan", "scan")).toBe(false);
    expect(c.lookup("X")).toBe("cfg");
  });

  it("suggests only an unambiguous near-match", () => {
    const c = catalog();
    expect(c.suggest("chrome")).toEqual({ alias: "google chrome", command: "C:\\Menu\\Google Chrome.lnk" });
    expect(c.suggest("pait")).toMatchObject({ command: "C:\\Menu\\Paint.lnk" });
    expect(c.suggest("note")).toBeUndefined(); // OneNote vs Notepad++
    expect(c.suggest("pa")).toBeUndefined(); // too short
    expect(c.suggest("zzzzz")).toBeUndefined();
  });

  it("learns only known commands and never overrides config", () => {
    const c = catalog();
    expect(c.learn("navegador", "evil.exe")).toBe(false);
    expect(c.learn("vs code", "C:\\Menu\\Paint.lnk")).toBe(false);
    expect(c.learn("navegador", "C:\\Menu\\Google Chrome.lnk")).toBe(true);
    expect(c.lookup("Navegador")).toBe("C:\\Menu\\Google Chrome.lnk");
    expect(c.forget("vs code")).toBe(false); // only learned aliases are forgettable
    expect(c.forget("navegador")).toBe(true);
    expect(c.lookup("navegador")).toBeUndefined();
  });

  it("restores persisted aliases and drops stale ones", () => {
    const store = new MemoryAliasStore();
    const a = new AppCatalog(store);
    a.add("chrome app", "cmd1", "scan");
    a.learn("web", "cmd1");
    store.save({ alias: "gone", command: "uninstalled", createdAt: 1 });

    const b = new AppCatalog(store);
    b.add("chrome app", "cmd1", "scan");
    b.restore();
    expect(b.lookup("web")).toBe("cmd1");
    expect(b.lookup("gone")).toBeUndefined();
  });
});

describe("IntentRouter with a catalog", () => {
  it("opens exact aliases directly and attaches a learn follow-up for near-matches", () => {
    const r = new IntentRouter({ apps: catalog() });
    expect(r.resolve("abre paint")).toMatchObject({ tool: "apps.open", args: { app: "C:\\Menu\\Paint.lnk" }, confidence: 1 });
    expect(r.resolve("abre chrome")).toMatchObject({
      tool: "apps.open",
      then: { tool: "aliases.learn", args: { alias: "chrome", command: "C:\\Menu\\Google Chrome.lnk" } },
    });
    expect(r.resolve("abre un debate").route).toBe("llm");
    expect(r.resolve("olvida el alias chrome")).toMatchObject({ tool: "aliases.forget", args: { alias: "chrome" } });
  });
});

const model: ModelCapabilities = {
  model: "m", provider: "fake", supportsVision: false, supportsTools: false, supportsStreaming: true,
  contextWindow: 1000, estimatedInputCost: 0, estimatedOutputCost: 0, expectedLatency: 1, isLocal: true,
};

function setup(grant: boolean) {
  const c = catalog();
  const opened: string[] = [];
  const asked: string[] = [];
  const orch = new Orchestrator({
    bus: new EventBus(),
    intents: new IntentRouter({ apps: c }),
    router: new StaticRouter("m"),
    providers: new ProviderRegistry().register(new FakeProvider("fake", [model], () => "x")),
    tools: new ToolRegistry()
      .register(makeAppsOpen(async (a) => void opened.push(a)))
      .register(makeAliasesLearn(c))
      .register(makeAliasesForget(c))
      .register(makeAliasesList(c)),
    policy: new PolicyEngine(),
    askPermission: async (r) => (asked.push(r.tool), grant),
    traces: new MemoryTraceStore(),
  });
  return { orch, c, opened, asked };
}

describe("learning an alias through the orchestrator", () => {
  it("opens the app, asks once, then resolves the alias exactly", async () => {
    const { orch, c, opened, asked } = setup(true);
    const t = await orch.run("abre chrome");
    expect(t.finalOutcome).toBe("success");
    expect(opened).toEqual(["C:\\Menu\\Google Chrome.lnk"]);
    expect(asked).toEqual(["aliases.learn"]);
    expect(c.lookup("chrome")).toBe("C:\\Menu\\Google Chrome.lnk");

    await orch.run("abre chrome");
    expect(asked).toHaveLength(1); // exact match now: no confirmation
    expect(opened).toHaveLength(2);
  });

  it("saves nothing when the user declines, and the app still opened", async () => {
    const { orch, c, opened } = setup(false);
    const t = await orch.run("abre chrome");
    expect(t.finalOutcome).toBe("success");
    expect(opened).toHaveLength(1);
    expect(c.lookup("chrome")).toBeUndefined();
  });

  it("forgets a learned alias without asking", async () => {
    const { orch, c, asked } = setup(true);
    await orch.run("abre chrome");
    asked.length = 0;
    await orch.run("olvida el alias chrome");
    expect(c.lookup("chrome")).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
