import { readdir } from "node:fs/promises";
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
