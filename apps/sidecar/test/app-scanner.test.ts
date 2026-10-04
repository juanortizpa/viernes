import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPS_FOLDER, defaultStartMenuRoots, scanShellApps, scanStartMenu } from "../src/app-scanner";

describe("scanStartMenu", () => {
  it("lists shortcuts recursively and skips uninstallers, non-shortcuts and unsafe names", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-menu-"));
    mkdirSync(join(root, "Microsoft Office"), { recursive: true });
    writeFileSync(join(root, "Paint.lnk"), "");
    writeFileSync(join(root, "Microsoft Office", "Word.LNK"), "");
    writeFileSync(join(root, "Uninstall Foo.lnk"), "");
    writeFileSync(join(root, "Tom & Jerry.lnk"), "");
    writeFileSync(join(root, "readme.txt"), "");

    const apps = await scanStartMenu([root, join(root, "does-not-exist")]);
    expect(apps.map((a) => a.alias).sort()).toEqual(["Paint", "Word"]);
    expect(apps.find((a) => a.alias === "Paint")?.command).toBe(join(root, "Paint.lnk"));
  });

  it("only has default roots on Windows", () => {
    expect(defaultStartMenuRoots({ APPDATA: "/a" }, "linux")).toEqual([]);
    expect(defaultStartMenuRoots({ APPDATA: "/a", ProgramData: "/p" }, "win32")).toHaveLength(2);
  });

  it("reads Start apps (Teams, Store apps) as shell:AppsFolder commands", async () => {
    const json = JSON.stringify([
      { Name: "Microsoft Teams", AppID: "MSTeams_8wekyb3d8bbwe!MSTeams" },
      { Name: "Uninstall Thing", AppID: "x" },
      { Name: "Bad", AppID: 'a"b' },
    ]);
    expect(await scanShellApps(async () => json, "win32")).toEqual([
      { alias: "Microsoft Teams", command: `${APPS_FOLDER}MSTeams_8wekyb3d8bbwe!MSTeams` },
    ]);
    const one = JSON.stringify({ Name: "Calculadora", AppID: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" });
    expect(await scanShellApps(async () => one, "win32")).toHaveLength(1);
  });

  it("returns nothing off Windows or when PowerShell fails or prints garbage", async () => {
    expect(await scanShellApps(async () => "[]", "linux")).toEqual([]);
    expect(await scanShellApps(async () => Promise.reject(new Error("no ps")), "win32")).toEqual([]);
    expect(await scanShellApps(async () => "not json", "win32")).toEqual([]);
  });
});
