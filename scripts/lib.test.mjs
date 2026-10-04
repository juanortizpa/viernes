import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig, findFile, nodeOk, parseEnvFile, pickWhisperAsset, serializeEnv } from "./lib.mjs";

const base = {
  defaultModel: "openai/gpt-oss-20b", router: "rules", freeOnly: true,
  groq: { models: [{ model: "openai/gpt-oss-20b" }, { model: "openai/gpt-oss-120b" }] },
  openrouter: { models: [{ model: "liquid/lfm-2.5-2.6b:free" }] },
  google: { models: [{ model: "gemini-3.1-flash-lite" }] },
};

describe("env file", () => {
  it("round-trips, ignores comments and blanks, strips quotes", () => {
    expect(parseEnvFile("# c\nGROQ_API_KEY=abc\n\nGEMINI_API_KEY = 'x y'\r\nBAD LINE\n")).toEqual({ GROQ_API_KEY: "abc", GEMINI_API_KEY: "x y" });
    expect(serializeEnv({ A: "1", B: "", C: "3" })).toBe("A=1\nC=3\n");
  });
});

describe("nodeOk", () => {
  it("requires 22.13+", () => {
    expect(nodeOk("v22.13.0")).toBe(true);
    expect(nodeOk("v24.1.0")).toBe(true);
    expect(nodeOk("v22.12.9")).toBe(false);
    expect(nodeOk("v20.19.0")).toBe(false);
  });
});

describe("buildConfig", () => {
  it("drops providers without a key so the sidecar can start, and keeps defaultModel valid", () => {
    const c = buildConfig({ base, env: { OPENROUTER_API_KEY: "k" } });
    expect(Object.keys(c).filter((k) => ["groq", "openrouter", "google"].includes(k))).toEqual(["openrouter"]);
    expect(c.defaultModel).toBe("liquid/lfm-2.5-2.6b:free");
    expect(c.freeOnly).toBe(true);
  });
  it("accepts GOOGLE_API_KEY for google and goes offline-friendly with no keys at all", () => {
    expect(buildConfig({ base, env: { GOOGLE_API_KEY: "k" } }).google).toBeDefined();
    const none = buildConfig({ base, env: {} });
    expect(none.groq ?? none.openrouter ?? none.google).toBeUndefined();
    expect(none.defaultModel).toBeUndefined();
  });
  it("does not mutate the base and writes voice paths with forward slashes", () => {
    const c = buildConfig({ base, env: { GROQ_API_KEY: "k" }, voice: { binary: "C:\\x\\whisper-cli.exe", model: "C:\\x\\ggml-base.bin" } });
    expect(c.voice).toEqual({ binary: "C:/x/whisper-cli.exe", model: "C:/x/ggml-base.bin", language: "auto", threads: 4 });
    expect(base.openrouter).toBeDefined();
    expect(c.defaultModel).toBe("openai/gpt-oss-20b");
  });
});

describe("pickWhisperAsset / findFile", () => {
  it("prefers the plain CPU x64 build and never a CUDA/BLAS one", () => {
    const names = (r) => pickWhisperAsset({ assets: r.map((name) => ({ name })) })?.name;
    expect(names(["whisper-cublas-12.4.0-bin-x64.zip", "whisper-bin-Win32.zip", "whisper-bin-x64.zip"])).toBe("whisper-bin-x64.zip");
    expect(names(["whisper-blas-bin-x64.zip", "whisper-cublas-bin-x64.zip"])).toBeUndefined();
    expect(names(["whisper-bin-x64-v2.zip"])).toBe("whisper-bin-x64-v2.zip");
    expect(pickWhisperAsset(undefined)).toBeUndefined();
  });
  it("finds the binary in a nested folder, case-insensitively", () => {
    const d = mkdtempSync(join(tmpdir(), "jarvis-find-"));
    mkdirSync(join(d, "Release"));
    writeFileSync(join(d, "Release", "Whisper-CLI.exe"), "x");
    expect(findFile(d, ["whisper-cli.exe"])).toBe(join(d, "Release", "Whisper-CLI.exe"));
    expect(findFile(d, ["nope.exe"])).toBeUndefined();
  });
});
