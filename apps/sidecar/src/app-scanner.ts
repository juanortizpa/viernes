import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, extname, join } from "node:path";

export interface ScannedApp {
  alias: string;
  command: string;
}

const MAX_APPS = 2000;
const MAX_DEPTH = 4;
/** Characters cmd.exe would interpret; such entries are skipped rather than escaped. */
const UNSAFE = /[&|<>^%"!`;]/;
const NOISE = /uninstall|desinstal/i;

/** Start Menu folders of the machine and the current user (Windows). */
export function defaultStartMenuRoots(env: Record<string, string | undefined>, platform: string = process.platform): string[] {
  if (platform !== "win32") return [];
  const rel = join("Microsoft", "Windows", "Start Menu", "Programs");
  return [env.ProgramData, env.APPDATA].filter((b): b is string => !!b).map((b) => join(b, rel));
}

/**
 * Lists `.lnk` shortcuts under the given roots. The shortcut path itself is the launch command, so
 * discovery never invents or interprets a command line. Unreadable folders are skipped.
 */
export async function scanStartMenu(roots: string[]): Promise<ScannedApp[]> {
  const found: ScannedApp[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_APPS) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1);
      } else if (extname(e.name).toLowerCase() === ".lnk") {
        const alias = basename(e.name, extname(e.name));
        if (!NOISE.test(alias) && !UNSAFE.test(full)) found.push({ alias, command: full });
      }
    }
  };
  for (const root of roots) await walk(root, 0);
  return found;
}

/** Launch prefix understood by `explorer.exe` for Store (MSIX/UWP) and other shell-registered apps. */
export const APPS_FOLDER = "shell:AppsFolder\\";

type RunPowerShell = (script: string) => Promise<string>;

const runPowerShell: RunPowerShell = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

/**
 * Apps the Start Menu knows by AppUserModelID (Teams, Calculator, Store apps...). Launched through
 * `explorer.exe shell:AppsFolder\<id>`, never through a shell, so the id is only ever an argv element.
 */
export async function scanShellApps(run: RunPowerShell = runPowerShell, platform: string = process.platform): Promise<ScannedApp[]> {
  if (platform !== "win32") return [];
  let raw: string;
  try {
    raw = await run("Get-StartApps | ConvertTo-Json -Compress");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const apps: ScannedApp[] = [];
  for (const item of list) {
    if (apps.length >= MAX_APPS) break;
    const { Name, AppID } = (item ?? {}) as { Name?: unknown; AppID?: unknown };
    if (typeof Name !== "string" || typeof AppID !== "string" || !Name.trim() || !AppID) continue;
    if (NOISE.test(Name) || /[\u0000-\u001f"]/.test(AppID)) continue;
    apps.push({ alias: Name.trim(), command: APPS_FOLDER + AppID });
  }
  return apps;
}

/** Classic shortcuts first (they launch reliably), then shell apps fill what is missing. */
export async function scanInstalledApps(roots: string[]): Promise<ScannedApp[]> {
  return [...(await scanStartMenu(roots)), ...(await scanShellApps())];
}
