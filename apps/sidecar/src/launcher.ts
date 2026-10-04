import { spawn } from "node:child_process";
import type { AppLauncher } from "@jarvis/tools";
import { APPS_FOLDER } from "./app-scanner";

/**
 * Launches a configured command. The command comes from the user's config alias table,
 * never from model or user text, and is passed as an argv element (no shell interpolation).
 */
export const launchApp: AppLauncher = (command) =>
  new Promise((resolve, reject) => {
    const [file, args]: [string, string[]] =
      process.platform !== "win32"
        ? [command, []]
        : command.startsWith(APPS_FOLDER)
          ? ["explorer.exe", [command]]
          : ["cmd", ["/c", "start", "", command]];
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
