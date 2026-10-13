import { quantiles } from './stats.js';
import type {
  CaseDistribution,
  Distribution,
  DistributionOptions,
  Report,
} from './types.js';

/** Buckets of a distribution, see `DistributionOptions`. */
export const DEFAULT_BUCKETS = 30;
/** Share of runs that keeps an edge in the range, see `DistributionOptions`. */
export const DEFAULT_TRIM = 0.001;

/** Tolerance of float division, so `3.0000000001` buckets are 3. */
const EPSILON = 1e-9;
/** Rounds of narrowing the range to buckets that hold `trim` of the runs. */
const TRIM_ROUNDS = 4;

/** A case's run times, overhead subtracted, with their counts. */
interface CaseTimes {
  readonly name: string;
  readonly times: readonly number[];
  readonly counts: readonly number[];
  readonly runs: number;
}

/** Equal buckets from `start`. */
interface Grid {
  readonly start: number;
  readonly width: number;
  readonly count: number;
}

/**
 * Buckets covering `low` to `high`, at most `buckets`, each a whole number
 * of timer steps (`quantum`) wide. Times the timer can't tell apart sit in
 * the middle of their bucket, safe from rounding at the edges.
 */
const gridOf = (
  low: number,
  high: number,
  quantum: number,
  buckets: number
): Grid => {
  const span = high - low + quantum;
  const width = Math.ceil(span / buckets / quantum - EPSILON) * quantum;
  return {
    start: Math.max(0, low - quantum / 2),
    width,
    count: Math.max(1, Math.ceil(span / width - EPSILON)),
  };
};

const bucketOf = ({ start, width, count }: Grid, time: number): number =>
  Math.min(count - 1, Math.max(0, Math.floor((time - start) / width)));

/**
 * Narrows `[low, high]` while a bucket at either edge holds less than
 * `trim` of the runs of every case: sparse outliers, like GC pauses, would
 * squeeze the other runs into a few buckets.
 */
const trimSparseEdges = (
  cases: readonly CaseTimes[],
  range: readonly [number, number],
  quantum: number,
  buckets: number,
  trim: number
): [number, number] => {
  let [low, high] = range;
  for (let round = 0; round < TRIM_ROUNDS; round++) {
    const grid = gridOf(low, high, quantum, buckets);
    const shares = new Array<number>(grid.count).fill(0);
    for (const { times, counts, runs } of cases) {
      const caseCounts = new Array<number>(grid.count).fill(0);
      times.forEach((time, index) => {
        if (time < low || time > high) return;
        const bucket = bucketOf(grid, time);
        caseCounts[bucket] = (caseCounts[bucket] ?? 0) + (counts[index] ?? 0);
      });
      caseCounts.forEach((count, bucket) => {
        shares[bucket] = Math.max(shares[bucket] ?? 0, count / runs);
      });
    }
    let first = 0;
    let last = grid.count - 1;
    while (first < last && (shares[first] ?? 0) < trim) first++;
    while (last > first && (shares[last] ?? 0) < trim) last--;
    if (first === 0 && last === grid.count - 1) break;
    const from = grid.start + first * grid.width;
    const to = grid.start + (last + 1) * grid.width;
    let kept: [number, number] = [Infinity, -Infinity];
    for (const { times } of cases)
      for (const time of times)
        if (time >= low && time <= high && time >= from && time < to)
          kept = [Math.min(kept[0], time), Math.max(kept[1], time)];
    if (!(kept[0] <= kept[1])) break;
    [low, high] = kept;
  }
  return [low, high];
};

/**
 * Puts the run times of a report's cases in equal buckets over one range
 * shared by all cases: time on the X axis, percent of runs on the Y axis.
 * See `Distribution`.
 *
 * The range leaves out the `trim` share of the fastest and slowest runs of
 * each case, then narrows while a bucket at either edge holds less than
 * `trim` of any case's runs. Bucket widths are whole multiples of the
 * timer's resolution per call (the finest of the cases, when their batch
 * sizes differ), so times the timer can't tell apart never leave empty
 * buckets between full ones. When that gives fewer buckets than
 * asked for, the range is padded with empty buckets, centered, to a whole
 * fraction of `buckets` (`buckets / k`): plotted in `buckets` columns, every
 * bucket is then exactly `k` columns wide. Times are shifted by the timer
 * overhead of cases measured with `subtractOverhead`.
 *
 * @throws RangeError for invalid options.
 */
export const distribution = (
  report: Report,
  { buckets = DEFAULT_BUCKETS, trim = DEFAULT_TRIM }: DistributionOptions = {}
): Distribution => {
  if (!Number.isSafeInteger(buckets) || buckets < 1)
    throw new RangeError(
      `mm-bench: buckets must be an integer of at least 1, got ${String(buckets)}.`
    );
  if (!(trim >= 0 && trim < 0.5))
    throw new RangeError(
      `mm-bench: trim must be at least 0 and below 0.5, got ${String(trim)}.`
    );
  if (report.cases.length === 0)
    return { start: 0, end: 0, width: 0, cases: [] };

  const resolution = Math.max(1, report.environment.timerResolution || 1);
  // the finest timer step of the cases: a case timed more coarsely (smaller
  // batches) shows gaps between the times its timer can tell apart
  const quantum = Math.min(
    ...report.cases.map(({ options }) => resolution / options.batchSize)
  );
  const cases = report.cases.map(
    ({ name, histogram, stats, overhead, options }): CaseTimes => {
      const shift = options.subtractOverhead ? overhead : 0;
      return {
        name,
        times: histogram.durations.map((duration) =>
          Math.max(0, duration - shift)
        ),
        counts: histogram.counts,
        runs: stats.runs,
      };
    }
  );
  const ends = cases.map(({ times, counts, runs }) =>
    quantiles({ durations: times, counts }, [trim, 1 - trim], runs)
  );
  const [low, high] = trimSparseEdges(
    cases,
    [
      Math.min(...ends.map(([start = 0]) => start)),
      Math.max(...ends.map(([, end = 0]) => end)),
    ],
    quantum,
    buckets,
    trim
  );

  const grid = gridOf(low, high, quantum, buckets);
  const share = Math.max(1, Math.floor(buckets / grid.count));
  const padding = Math.floor(buckets / share) - grid.count;
  const left = Math.min(
    Math.floor(padding / 2),
    Math.floor(grid.start / grid.width)
  );
  const padded: Grid = {
    start: grid.start - left * grid.width,
    width: grid.width,
    count: grid.count + padding,
  };

  return {
    start: padded.start,
    end: padded.start + padded.count * padded.width,
    width: padded.width,
    cases: cases.map(({ name, times, counts, runs }): CaseDistribution => {
      const bucketCounts = new Array<number>(padded.count).fill(0);
      let below = 0;
      let above = 0;
      times.forEach((time, index) => {
        const count = counts[index] ?? 0;
        if (time < low) below += count;
        else if (time > high) above += count;
        else {
          const bucket = bucketOf(padded, time);
          bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + count;
        }
      });
      return {
        name,
        percents: bucketCounts.map((count) => (count / runs) * 100),
        counts: bucketCounts,
        below,
        above,
      };
    }),
  };
};
