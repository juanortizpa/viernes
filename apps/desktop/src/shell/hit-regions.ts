/**
 * Tells the Tauri shell where the island's interactive parts are, so the transparent rest of the window lets clicks
 * through to the apps underneath (src-tauri/src/overlay.rs). Rects are CSS px relative to the window.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Painted, clickable parts of the island window. */
export const HIT_SELECTOR = ".island, .dock, .island-settings, .dock__note--float";

export const toRect = (r: { left: number; top: number; width: number; height: number }): Rect => ({
  x: Math.floor(r.left),
  y: Math.floor(r.top),
  w: Math.ceil(r.width),
  h: Math.ceil(r.height),
});

/** Sends only when the regions or the hold flag really changed (the shell polls; the IPC should not). */
export class HitRegionReporter {
  private last = "";
  constructor(private readonly send: (rects: Rect[], hold: boolean) => void) {}

  report(rects: Rect[], hold: boolean): void {
    const visible = rects.filter((r) => r.w > 0 && r.h > 0);
    const key = JSON.stringify([visible, hold]);
    if (key === this.last) return;
    this.last = key;
    this.send(visible, hold);
  }
}

/**
 * Measures `root`'s interactive children every `intervalMs` (animations move them) and right away when a pointer goes
 * down or up, so a held push-to-talk keeps the mouse even if the cursor drifts off the island. Returns a cleanup.
 */
export function reportHitRegions(root: HTMLElement, send: (rects: Rect[], hold: boolean) => void, intervalMs = 100): () => void {
  const reporter = new HitRegionReporter(send);
  let hold = false;
  const measure = () => reporter.report([...root.querySelectorAll<HTMLElement>(HIT_SELECTOR)].map((el) => toRect(el.getBoundingClientRect())), hold);
  const down = () => ((hold = true), measure());
  const up = () => ((hold = false), measure());
  root.addEventListener("pointerdown", down);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  const timer = setInterval(measure, intervalMs);
  measure();
  return () => {
    clearInterval(timer);
    root.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
}
