import { countRuns } from './recorder.js';
import type { Histogram, Stats } from './types.js';

/**
 * Nearest-rank quantiles of a histogram: for each `q`, the smallest
 * duration with at least that share of the runs at or below it.
 *
 * @param quantiles Shares from 0 to 1, ascending.
 */
export const quantiles = (
  { durations, counts }: Histogram,
  quantiles: readonly number[],
  total = countRuns({ durations, counts })
): number[] => {
  const result: number[] = [];
  let index = 0;
  let cumulative = counts[0] ?? 0;
  for (const q of quantiles) {
    const rank = Math.max(1, Math.ceil(q * total));
    while (cumulative < rank && index < durations.length - 1)
      cumulative += counts[++index] ?? 0;
    result.push(durations[index] ?? NaN);
  }
  return result;
};

/**
 * Stats of a histogram's times per call.
 *
 * @param shift Subtracted from every time (the timer overhead), which never
 * goes below 0.
 */
export const computeStats = (histogram: Histogram, shift = 0): Stats => {
  const { durations, counts } = histogram;
  const runs = countRuns(histogram);
  let sum = 0;
  durations.forEach((duration, index) => {
    sum += duration * (counts[index] ?? 0);
  });
  const rawMean = sum / runs;
  let squares = 0;
  durations.forEach((duration, index) => {
    squares += (duration - rawMean) ** 2 * (counts[index] ?? 0);
  });
  const shifted = (value: number): number => Math.max(0, value - shift);
  const [median = NaN, p75 = NaN, p99 = NaN, p999 = NaN] = quantiles(
    histogram,
    [0.5, 0.75, 0.99, 0.999],
    runs
  ).map(shifted);
  const mean = shifted(rawMean);
  return {
    runs,
    mean,
    min: shifted(durations[0] ?? NaN),
    max: shifted(durations.at(-1) ?? NaN),
    median,
    p75,
    p99,
    p999,
    stdDev: Math.sqrt(squares / runs),
    opsPerSecond: mean > 0 ? 1e9 / mean : Infinity,
  };
};
