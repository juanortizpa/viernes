/**
 * Keeps the Tauri window just as tall as the island and its dock. A fixed 240 px window cut off a tall island (permission
 * prompt, long error) and, while the island was collapsed, its empty transparent area still blocked clicks to the apps
 * underneath. Grows at once (nothing is ever clipped), shrinks only once the content has settled (no jitter while the
 * island animates).
 */
export interface WindowFitOptions {
  setHeight: (px: number) => void;
  /** Room for the island's drop shadow below the content. */
  margin?: number;
  min?: number;
  max?: number;
  shrinkDelayMs?: number;
  /** Heights are rounded up to this step, so an expanding animation costs a few resizes instead of one per frame. */
  step?: number;
}

export class WindowFitter {
  private current?: number;
  private shrinkTimer?: ReturnType<typeof setTimeout>;
  private readonly margin: number;
  private readonly min: number;
  private readonly max: number;
  private readonly shrinkDelayMs: number;
  private readonly step: number;

  constructor(private readonly opts: WindowFitOptions) {
    this.margin = opts.margin ?? 28;
    this.min = opts.min ?? 72;
    this.max = opts.max ?? 640;
    this.shrinkDelayMs = opts.shrinkDelayMs ?? 450;
    this.step = opts.step ?? 32;
  }

  /** `contentBottom`: bottom edge of the painted content, in CSS px from the top of the window. */
  update(contentBottom: number): void {
    const target = Math.min(this.max, Math.max(this.min, Math.ceil((contentBottom + this.margin) / this.step) * this.step));
    if (target === this.current) return void clearTimeout(this.shrinkTimer);
    if (this.current === undefined || target > this.current) {
      clearTimeout(this.shrinkTimer);
      this.apply(target);
      return;
    }
    clearTimeout(this.shrinkTimer);
    this.shrinkTimer = setTimeout(() => this.apply(target), this.shrinkDelayMs);
  }

  dispose(): void {
    clearTimeout(this.shrinkTimer);
  }

  private apply(h: number): void {
    this.current = h;
    this.opts.setHeight(h);
  }
}

/** Observes `el` and resizes the current Tauri window to fit it. Returns a cleanup function. */
export function fitWindowTo(el: HTMLElement, width: number, setSize: (w: number, h: number) => Promise<unknown>): () => void {
  const fitter = new WindowFitter({ setHeight: (h) => void setSize(width, h).catch(() => undefined) });
  const measure = () => fitter.update(el.getBoundingClientRect().bottom);
  const ro = new ResizeObserver(measure);
  ro.observe(el);
  measure();
  return () => {
    ro.disconnect();
    fitter.dispose();
  };
}
