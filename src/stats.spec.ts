import { describe, expect, it } from 'vitest';
import { computeStats, quantiles } from './stats.js';

const even = { durations: [10, 20, 30, 40], counts: [1, 1, 1, 1] };

describe('quantiles', () => {
  it('takes the nearest rank', () => {
    expect(quantiles(even, [0, 0.25, 0.5, 0.51, 0.75, 1])).toEqual([
      10, 10, 20, 30, 30, 40,
    ]);
  });

  it('weighs durations by their counts', () => {
    const skewed = { durations: [1, 100], counts: [99, 1] };
    expect(quantiles(skewed, [0.5, 0.99, 0.999])).toEqual([1, 1, 100]);
  });
});

describe('computeStats', () => {
  it('computes the stats of a histogram', () => {
    expect(computeStats(even)).toEqual({
      runs: 4,
      mean: 25,
      min: 10,
      max: 40,
      median: 20,
      p75: 30,
      p99: 40,
      p999: 40,
      stdDev: Math.sqrt(125),
      opsPerSecond: 1e9 / 25,
    });
  });

  it('subtracts the shift, never below 0', () => {
    expect(computeStats(even, 15)).toMatchObject({
      mean: 10,
      min: 0,
      median: 5,
      max: 25,
      stdDev: Math.sqrt(125),
    });
  });

  it('reports endless ops for a mean of 0', () => {
    const stats = computeStats({ durations: [10], counts: [3] }, 50);
    expect(stats.mean).toBe(0);
    expect(stats.opsPerSecond).toBe(Infinity);
  });
});
