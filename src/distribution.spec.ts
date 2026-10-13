import { describe, expect, it } from 'vitest';
import { distribution } from './distribution.js';
import { reportOf } from './fixtures/reports.js';

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

describe('distribution', () => {
  it('puts runs in equal buckets: 30% 200ns, 60% 400ns, 10% 600ns', () => {
    const report = reportOf(
      [{ name: 'a', durations: [200, 400, 600], counts: [30, 60, 10] }],
      200
    );
    expect(distribution(report, { buckets: 3, trim: 0 })).toEqual({
      start: 100,
      end: 700,
      width: 200,
      cases: [
        {
          name: 'a',
          percents: [30, 60, 10],
          counts: [30, 60, 10],
          below: 0,
          above: 0,
        },
      ],
    });
  });

  it('keeps bucket widths whole multiples of the timer step', () => {
    const durations = Array.from(
      { length: 100 },
      (_, index) => (index + 1) * 100
    );
    const report = reportOf(
      [{ name: 'a', durations, counts: durations.map(() => 1) }],
      100
    );
    const { width, cases } = distribution(report, { buckets: 30, trim: 0 });
    expect(width % 100).toBe(0);
    const counts = cases[0]!.counts;
    const used = counts.slice(counts.findIndex((count) => count > 0));
    const last = used.findLastIndex((count) => count > 0);
    // no gaps between buckets with runs
    expect(used.slice(0, last + 1).every((count) => count > 0)).toBe(true);
    expect(sum(counts)).toBe(100);
  });

  it('pads to a whole fraction of the buckets, centered', () => {
    const report = reportOf(
      [{ name: 'a', durations: [1000, 1100, 1200], counts: [3, 6, 1] }],
      100
    );
    const result = distribution(report, { buckets: 5, trim: 0 });
    expect(result).toMatchObject({ start: 850, end: 1350, width: 100 });
    expect(result.cases[0]!.percents).toEqual([0, 30, 60, 10, 0]);
    // 3 buckets of runs in 8 columns: 4 buckets of 2 columns each
    expect(
      distribution(report, { buckets: 8, trim: 0 }).cases[0]!.counts
    ).toHaveLength(4);
  });

  it('leaves the trimmed share out of the range and counts it', () => {
    const report = reportOf([
      { name: 'a', durations: [100, 200, 100_000], counts: [500, 499, 1] },
    ]);
    const { end, cases } = distribution(report, { buckets: 10 });
    expect(end).toBeLessThan(1000);
    expect(cases[0]).toMatchObject({ below: 0, above: 1 });
    expect(sum(cases[0]!.counts)).toBe(999);
    expect(sum(cases[0]!.percents)).toBeCloseTo(99.9);
  });

  it('trims sparse outliers at the edges', () => {
    const outliers = Array.from(
      { length: 10 },
      (_, index) => (index + 1) * 1000
    );
    const report = reportOf(
      [
        {
          name: 'a',
          durations: [100, 200, ...outliers],
          counts: [600, 400, ...outliers.map(() => 1)],
        },
      ],
      100
    );
    const { end, cases } = distribution(report, { buckets: 30 });
    expect(end).toBeLessThan(1000);
    expect(cases[0]).toMatchObject({ below: 0, above: 10 });
  });

  it('keeps an edge that holds enough runs of any case', () => {
    const report = reportOf(
      [
        { name: 'fast', durations: [100], counts: [1000] },
        { name: 'slow', durations: [5000], counts: [10] },
      ],
      100
    );
    const { start, end, cases } = distribution(report, { buckets: 10 });
    expect(start).toBeLessThanOrEqual(100);
    expect(end).toBeGreaterThan(5000);
    expect(cases.map(({ above, below }) => above + below)).toEqual([0, 0]);
    expect(cases[0]!.counts[0]).toBe(1000);
    expect(cases[1]!.counts.at(-1)).toBe(10);
  });

  it('shifts times by the overhead of cases that subtract it', () => {
    const report = reportOf([
      { name: 'a', durations: [150, 250], counts: [1, 1], overhead: 50 },
      {
        name: 'b',
        durations: [150, 250],
        counts: [1, 1],
        overhead: 50,
        options: { subtractOverhead: false },
      },
    ]);
    const { start, end } = distribution(report, { buckets: 10, trim: 0 });
    expect(start).toBeLessThanOrEqual(100);
    expect(end).toBeGreaterThanOrEqual(250);
    const [a, b] = distribution(report, { buckets: 10, trim: 0 }).cases;
    expect(a!.counts.indexOf(1)).toBeLessThan(b!.counts.indexOf(1));
  });

  it('uses the finest timer step of the cases', () => {
    const report = reportOf(
      [
        { name: 'single', durations: [100, 200], counts: [1, 1] },
        {
          name: 'batched',
          durations: [150.5, 151.5],
          counts: [1, 1],
          options: { batchSize: 100 },
        },
      ],
      100
    );
    expect(distribution(report, { buckets: 200, trim: 0 }).width).toBe(1);
  });

  it('handles an empty report', () => {
    const report = { ...reportOf([]), cases: [] };
    expect(distribution(report)).toEqual({
      start: 0,
      end: 0,
      width: 0,
      cases: [],
    });
  });

  it('rejects invalid options', () => {
    const report = reportOf([{ name: 'a', durations: [1], counts: [1] }]);
    expect(() => distribution(report, { buckets: 0 })).toThrow(RangeError);
    expect(() => distribution(report, { buckets: 1.5 })).toThrow(RangeError);
    expect(() => distribution(report, { trim: 0.5 })).toThrow(RangeError);
    expect(() => distribution(report, { trim: -1 })).toThrow(RangeError);
  });
});
