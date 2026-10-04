import { describe, expect, it } from "vitest";
import { HitRegionReporter, toRect, type Rect } from "./hit-regions";

describe("HitRegionReporter", () => {
  it("sends only real changes and drops empty boxes", () => {
    const sent: [Rect[], boolean][] = [];
    const r = new HitRegionReporter((rects, hold) => sent.push([rects, hold]));
    const island = toRect({ left: 122.4, top: 8.2, width: 175.3, height: 47.6 });
    expect(island).toEqual({ x: 122, y: 8, w: 176, h: 48 });
    r.report([island, { x: 0, y: 0, w: 0, h: 0 }], false);
    r.report([island], false); // same thing: no IPC
    expect(sent).toEqual([[[island], false]]);
    r.report([island], true); // pointer pressed: the shell must keep the mouse
    r.report([{ ...island, h: 120 }], true); // island expanded
    expect(sent.map(([rects, hold]) => [rects[0]!.h, hold])).toEqual([
      [48, false],
      [48, true],
      [120, true],
    ]);
  });
});
