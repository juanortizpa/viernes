/** Small deterministic PRNG so every reported interval is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface Interval {
  estimate: number;
  lo: number;
  hi: number;
}

/**
 * Paired bootstrap: resample TASK indices (the same indices for every policy), so differences between policies
 * are measured on identical resamples. `stat` receives the resampled indices. 95% percentile interval.
 */
export function pairedBootstrap(n: number, stat: (idx: number[]) => number, opts: { resamples?: number; seed?: number } = {}): Interval {
  const B = opts.resamples ?? 2000;
  const rand = mulberry32(opts.seed ?? 1);
  const all = Array.from({ length: n }, (_, i) => i);
  const estimate = stat(all);
  if (n === 0) return { estimate: 0, lo: 0, hi: 0 };
  const draws: number[] = [];
  for (let b = 0; b < B; b++) draws.push(stat(Array.from({ length: n }, () => Math.floor(rand() * n))));
  draws.sort((x, y) => x - y);
  return { estimate, lo: draws[Math.floor(0.025 * B)]!, hi: draws[Math.min(B - 1, Math.floor(0.975 * B))]! };
}
