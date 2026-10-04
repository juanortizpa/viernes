import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStartMenuRoots, scanStartMenu } from "../src/app-scanner";

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
});
