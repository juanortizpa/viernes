const dist = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(s);
};

/**
 * Subsequence DTW: how well `template` matches ANY stretch of `window` (free start and end inside the window),
 * tolerating the speaker saying it faster or slower. Lower is better; normalised by template length.
 */
export function subsequenceDtw(template: Float32Array[], window: Float32Array[]): number {
  const n = template.length;
  const m = window.length;
  if (n === 0 || m < n / 2) return Infinity;
  let prev = new Float64Array(m);
  for (let j = 0; j < m; j++) prev[j] = dist(template[0]!, window[j]!); // free start
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(m);
    cur[0] = prev[0]! + dist(template[i]!, window[0]!);
    for (let j = 1; j < m; j++) cur[j] = dist(template[i]!, window[j]!) + Math.min(prev[j]!, cur[j - 1]!, prev[j - 1]!);
    prev = cur;
  }
  let best = Infinity;
  for (let j = 0; j < m; j++) best = Math.min(best, prev[j]!);
  return best / n;
}

/** Whole-sequence DTW (both ends anchored); used to compare two enrolment samples. */
export function fullDtw(a: Float32Array[], b: Float32Array[]): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return Infinity;
  let prev = new Float64Array(m).fill(Infinity);
  prev[0] = dist(a[0]!, b[0]!);
  for (let j = 1; j < m; j++) prev[j] = prev[j - 1]! + dist(a[0]!, b[j]!);
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(m).fill(Infinity);
    cur[0] = prev[0]! + dist(a[i]!, b[0]!);
    for (let j = 1; j < m; j++) cur[j] = dist(a[i]!, b[j]!) + Math.min(prev[j]!, cur[j - 1]!, prev[j - 1]!);
    prev = cur;
  }
  return prev[m - 1]! / (n + m);
}
