import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Rect } from "./hit-regions";

/** Mirrors `ShellInfo` in src-tauri/src/main.rs. */
export interface ShellInfo {
  /** Global push-to-talk, or null when the OS refused it (another app owns the combination). */
  pttShortcut: string | null;
  clickThrough: boolean;
}

export const shellInfo = (): Promise<ShellInfo> => invoke<ShellInfo>("shell_info");

export const setHitRegions = (rects: Rect[], hold: boolean): Promise<void> => invoke("set_hit_regions", { rects, hold });

/** Global push-to-talk from the shell: "pressed" / "released", even when the island has no focus. */
export function onGlobalPushToTalk(handler: (state: "pressed" | "released") => void): () => void {
  const off = listen<string>("jarvis://ptt", (e) => handler(e.payload === "pressed" ? "pressed" : "released"));
  return () => void off.then((f) => f());
}

export const hideIsland = (): Promise<void> => getCurrentWindow().hide();
