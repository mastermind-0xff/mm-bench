import type { Histogram } from './types.js';

/**
 * Run times below this many nanoseconds are counted in a flat array, the
 * rest in a map: fast runs, which are most of the runs, cost an index, and
 * the map only grows with slow runs, which are few.
 */
const FLAT_SIZE = 1 << 16;

/** Counts run times (whole nanoseconds per run) as they are measured. */
export class Recorder {
  private readonly flat = new Float64Array(FLAT_SIZE);
  private readonly sparse = new Map<number, number>();
  /** Lowest and highest index used in `flat`, to scan only that part. */
  private low = FLAT_SIZE;
  private high = -1;

  /** Counts one run of `ns` nanoseconds, a whole number of at least 0. */
  add(ns: number): void {
    if (ns < FLAT_SIZE) {
      this.flat[ns] = (this.flat[ns] ?? 0) + 1;
      if (ns < this.low) this.low = ns;
      if (ns > this.high) this.high = ns;
    } else this.sparse.set(ns, (this.sparse.get(ns) ?? 0) + 1);
  }

  /**
   * The counted runs as a histogram of times per call.
   *
   * @param batchSize Calls per run: times are divided by it.
   */
  histogram(batchSize = 1): Histogram {
    const durations: number[] = [];
    const counts: number[] = [];
    for (let ns = this.low; ns <= this.high; ns++) {
      const count = this.flat[ns] ?? 0;
      if (count === 0) continue;
      durations.push(ns / batchSize);
      counts.push(count);
    }
    const slow = [...this.sparse].sort(([a], [b]) => a - b);
    for (const [ns, count] of slow) {
      durations.push(ns / batchSize);
      counts.push(count);
    }
    return { durations, counts };
  }
}

/** Adds up histograms: counts of equal durations are summed. */
export const mergeHistograms = (
  histograms: readonly Histogram[]
): Histogram => {
  if (histograms.length === 1 && histograms[0] !== undefined)
    return histograms[0];
  const merged = new Map<number, number>();
  for (const { durations, counts } of histograms)
    durations.forEach((duration, index) => {
      merged.set(duration, (merged.get(duration) ?? 0) + (counts[index] ?? 0));
    });
  const sorted = [...merged].sort(([a], [b]) => a - b);
  return {
    durations: sorted.map(([duration]) => duration),
    counts: sorted.map(([, count]) => count),
  };
};

/** Sum of a histogram's counts. */
export const countRuns = ({ counts }: Histogram): number =>
  counts.reduce((sum, count) => sum + count, 0);
