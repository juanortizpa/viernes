import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowFitter } from "./window-fit";

describe("WindowFitter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("grows at once and only shrinks after the content settles", () => {
    const sizes: number[] = [];
    const f = new WindowFitter({ setHeight: (h) => sizes.push(h), margin: 20, shrinkDelayMs: 400, step: 1 });
    f.update(100);
    expect(sizes).toEqual([120]);
    f.update(250); // island expands: never clip it
    expect(sizes).toEqual([120, 270]);
    f.update(180); // collapsing animation...
    f.update(100); // ...settles
    vi.advanceTimersByTime(399);
    expect(sizes).toEqual([120, 270]);
    vi.advanceTimersByTime(1);
    expect(sizes).toEqual([120, 270, 120]);
  });

  it("a regrowth cancels a pending shrink; clamps to its bounds", () => {
    const sizes: number[] = [];
    const f = new WindowFitter({ setHeight: (h) => sizes.push(h), margin: 0, min: 80, max: 500, step: 1 });
    f.update(300);
    f.update(100);
    f.update(300); // back to the same size before the shrink fired
    vi.advanceTimersByTime(1000);
    expect(sizes).toEqual([300]);
    f.update(10_000);
    f.update(1);
    vi.advanceTimersByTime(1000);
    expect(sizes).toEqual([300, 500, 80]);
  });

  it("rounds up to steps so an animation costs a few resizes, not one per frame", () => {
    const sizes: number[] = [];
    const f = new WindowFitter({ setHeight: (h) => sizes.push(h), margin: 28 });
    for (let bottom = 108; bottom <= 250; bottom += 3) f.update(bottom); // ~50 animation frames
    expect(sizes).toEqual([160, 192, 224, 256, 288]);
  });
});
