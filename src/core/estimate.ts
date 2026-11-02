/**
 * Experimental estimate of undisclosed AI involvement ("beyond signatures").
 *
 * Adjusted classify-and-count on mean style scores: if undisclosed commits score `s` on average, the repo's
 * human commits `h` and its AI commits `a`, the AI share among the undisclosed commits is (s − h) / (a − h).
 * `h` comes from the repo's own commits before July 2022 when it has them, otherwise from the training data;
 * `a` from the repo's own disclosed commits when there are at least 10, otherwise from the training data.
 * A seeded bootstrap gives a 90% interval. Validated in eval/STYLE.md.
 */

export interface Prevalence {
  /** Estimated AI share among the undisclosed commits, 0..1. */
  point: number;
  lo: number;
  hi: number;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
}

/** Mixed scores of undisclosed commits `S`, human reference `H` and AI reference `A` (numbers or a known mean). */
export function prevalence(S: number[], H: number[] | number, A: number[] | number, seed = 42, rounds = 400): Prevalence | null {
  if (S.length === 0) return null;
  const one = (s: number[], h: number[] | number, a: number[] | number) => {
    const hm = typeof h === "number" ? h : mean(h);
    const am = typeof a === "number" ? a : mean(a);
    if (am - hm < 0.1) return NaN; // the two references cannot be told apart
    return Math.min(1, Math.max(0, (mean(s) - hm) / (am - hm)));
  };
  const point = one(S, H, A);
  if (Number.isNaN(point)) return null;
  const r = rng(seed);
  const resample = <T>(x: T[]) => x.map(() => x[Math.floor(r() * x.length)]!);
  const boots: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const v = one(resample(S), typeof H === "number" ? H : resample(H), typeof A === "number" ? A : resample(A));
    if (!Number.isNaN(v)) boots.push(v);
  }
  boots.sort((a, b) => a - b);
  return { point, lo: boots[Math.floor(0.05 * (boots.length - 1))] ?? point, hi: boots[Math.ceil(0.95 * (boots.length - 1))] ?? point };
}
