import { mkdirSync, mkdtempSync, rmSync as rmSyncQuiet, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig, describeAssets, explainExitCode, findFile, isDeprecatedWhisperStub, islandNeedsBuild, newestMtime, nodeOk, parseEnvFile, pickFromReleases, pickWhisperAsset, serializeEnv } from "./lib.mjs";

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
  it("adds the lighter wake-word verification model when given", () => {
    const c = buildConfig({ base, env: { GROQ_API_KEY: "k" }, voice: { binary: "C:\\x\\w.exe", model: "C:\\x\\base.bin", wakeModel: "C:\\x\\tiny.bin" } });
    expect(c.voice.wakeModel).toBe("C:/x/tiny.bin");
    expect(buildConfig({ base, env: {}, voice: { binary: "a", model: "b" } }).voice.wakeModel).toBeUndefined();
  });
  it("does not mutate the base and writes voice paths with forward slashes", () => {
    const c = buildConfig({ base, env: { GROQ_API_KEY: "k" }, voice: { binary: "C:\\x\\whisper-cli.exe", model: "C:\\x\\ggml-base.bin" } });
    expect(c.voice).toEqual({ binary: "C:/x/whisper-cli.exe", model: "C:/x/ggml-base.bin", language: "es", threads: 4 });
    expect(base.openrouter).toBeDefined();
    expect(c.defaultModel).toBe("openai/gpt-oss-20b");
  });
});

describe("pickFromReleases", () => {
  const rel = (tag, ...names) => ({ tag_name: tag, assets: names.map((name) => ({ name, browser_download_url: `https://x/${tag}/${name}` })) });
  it("skips a newer release that has no Windows build and falls back to an older one", () => {
    const r = pickFromReleases([rel("v9", "whisper-v9-xcframework.zip"), rel("v8"), rel("v7", "whisper-bin-x64.zip", "whisper-bin-Win32.zip")]);
    expect(r?.tag).toBe("v7");
    expect(r?.asset.name).toBe("whisper-bin-x64.zip");
  });
  it("accepts renamed Windows zips, rejects other platforms/GPU builds, skips drafts, and survives garbage", () => {
    expect(pickFromReleases([rel("v2", "whisper-2.0-bin-win64.zip")])?.asset.name).toBe("whisper-2.0-bin-win64.zip");
    expect(pickFromReleases([rel("v2", "whisper-cublas-bin-x64.zip", "whisper-macos-arm64.zip", "whisper-linux-x64.tar.gz")])).toBeUndefined();
    expect(pickFromReleases([{ ...rel("v3", "whisper-bin-x64.zip"), draft: true }])).toBeUndefined();
    expect(pickFromReleases({ message: "rate limited" })).toBeUndefined();
    expect(pickFromReleases(undefined)).toBeUndefined();
  });
  it("describes what it saw so the user can report it", () => {
    expect(describeAssets([rel("v1", "a.zip", "b.zip"), rel("v0")])).toBe("v1: a.zip, b.zip\n    v0: (sin archivos)");
    expect(describeAssets(undefined)).toBe("");
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

describe("whisper binary choice and diagnostics", () => {
  it("prefers whisper-cli.exe over the deprecated main.exe wherever they are", () => {
    const d = mkdtempSync(join(tmpdir(), "jarvis-pref-"));
    mkdirSync(join(d, "a"));
    mkdirSync(join(d, "z"));
    writeFileSync(join(d, "a", "main.exe"), "x"); // sorts first, must still lose
    writeFileSync(join(d, "z", "whisper-cli.exe"), "x");
    expect(findFile(d, ["whisper-cli.exe", "main.exe"])).toBe(join(d, "z", "whisper-cli.exe"));
    rmSyncQuiet(join(d, "z", "whisper-cli.exe"));
    expect(findFile(d, ["whisper-cli.exe", "main.exe"])).toBe(join(d, "a", "main.exe"));
  });
  it("recognises the stub and explains Windows start-up failures", () => {
    expect(isDeprecatedWhisperStub("C:\\t\\main.exe")).toBe(true);
    expect(isDeprecatedWhisperStub("C:/t/whisper-cli.exe")).toBe(false);
    expect(explainExitCode(3221225781)).toMatch(/0xC0000135.*DLL/);
    expect(explainExitCode(1)).toBe("0x1");
  });
});

describe("island build check", () => {
  it("finds the newest source and skips build outputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-island-"));
    try {
      mkdirSync(join(dir, "src/deep"), { recursive: true });
      mkdirSync(join(dir, "node_modules"));
      writeFileSync(join(dir, "src/a.ts"), "");
      writeFileSync(join(dir, "src/deep/b.ts"), "");
      writeFileSync(join(dir, "node_modules/x.js"), "");
      utimesSync(join(dir, "src/a.ts"), 1000, 1000);
      utimesSync(join(dir, "src/deep/b.ts"), 2000, 2000);
      utimesSync(join(dir, "node_modules/x.js"), 9000, 9000);
      expect(newestMtime([dir, join(dir, "missing")])).toBe(2_000_000);
      expect(newestMtime([join(dir, "missing")])).toBe(0);
    } finally {
      rmSyncQuiet(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds when missing, stale or forced, and only then", () => {
    expect(islandNeedsBuild({ exeMtime: 0, sourcesMtime: 5 })).toMatch(/no está compilada/);
    expect(islandNeedsBuild({ exeMtime: 10, sourcesMtime: 11 })).toMatch(/cambió/);
    expect(islandNeedsBuild({ exeMtime: 10, sourcesMtime: 9, force: true })).toMatch(/rebuild/);
    expect(islandNeedsBuild({ exeMtime: 10, sourcesMtime: 9 })).toBeUndefined();
  });
});
