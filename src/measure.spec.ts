import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  calibrate,
  collectGarbage,
  measure,
  sampleLimits,
  trimmedMean,
  type MeasureConfig,
} from './measure.js';

const config = (overrides: Partial<MeasureConfig> = {}): MeasureConfig => ({
  budget: { runs: 500 },
  warmup: { runs: 10 },
  batchSize: 1,
  tickInterval: 1,
  ...overrides,
});

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

describe('collectGarbage', () => {
  it('frees garbage without exposing gc to other code', () => {
    const exposed = 'gc' in globalThis;
    let garbage: unknown[] | undefined = Array.from(
      { length: 300_000 },
      (_, index) => ({ index })
    );
    const before = process.memoryUsage().heapUsed;
    expect(garbage).toHaveLength(300_000);
    garbage = undefined;
    collectGarbage();
    expect(process.memoryUsage().heapUsed).toBeLessThan(before - 5 * 1024 ** 2);
    expect(garbage).toBeUndefined();
    if (!exposed) {
      expect('gc' in globalThis).toBe(false);
      expect(runInNewContext('typeof gc')).toBe('undefined');
    }
  });
});

describe('measure', () => {
  it('times exactly the budget of runs of a sync function', async () => {
    const before = process.hrtime.bigint();
    const { async, sample, start } = await measure(
      () => Math.sqrt(2),
      config()
    );
    expect(async).toBe(false);
    expect(start).toBeGreaterThan(before);
    expect(sample.runs).toBe(500);
    expect(sum(sample.histogram.counts)).toBe(500);
    expect(sample.overhead).toBeGreaterThanOrEqual(0);
    expect(sample.innerTime).toBeLessThanOrEqual(sample.outerTime);
    const { ticks } = sample;
    expect(ticks.time[0]).toBe(0);
    expect(ticks.runs.at(-1)).toBe(500);
    expect(ticks.innerTime.at(-1)).toBe(sample.innerTime);
    for (const column of [
      ticks.runs,
      ticks.innerTime,
      ticks.cpu,
      ticks.threadCpu,
      ticks.rss,
      ticks.heapUsed,
    ])
      expect(column).toHaveLength(ticks.time.length);
  });

  it('calls the function once, warms it up, then measures batches', async () => {
    let calls = 0;
    const { sample } = await measure(
      () => ++calls,
      config({ budget: { runs: 100 }, warmup: { runs: 10 }, batchSize: 10 })
    );
    // first call, 2 warm-up halves of 5 runs, 100 measured runs
    expect(calls).toBe(1 + 10 * 10 + 100 * 10);
    expect(sample.runs).toBe(100);
    for (const duration of sample.histogram.durations)
      expect(duration * 10).toBeCloseTo(Math.round(duration * 10), 6);
  });

  it('skips the warm-up loops for an empty warm-up', async () => {
    let calls = 0;
    await measure(
      () => ++calls,
      config({ budget: { runs: 5 }, warmup: { time: 0 } })
    );
    expect(calls).toBe(6);
  });

  it('awaits functions returning promises', async () => {
    const { async, sample } = await measure(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 2);
        }),
      config({ budget: { runs: 3 }, warmup: { runs: 0 } })
    );
    expect(async).toBe(true);
    expect(sample.histogram.durations[0]).toBeGreaterThan(1e6);
  });

  it('treats any thenable as async', async () => {
    const thenable = {
      then(resolve: (value: number) => void) {
        resolve(1);
      },
    };
    const { async } = await measure(
      () => thenable,
      config({ budget: { runs: 3 } })
    );
    expect(async).toBe(true);
  });

  it('measures for the budget time, at least', async () => {
    const { sample } = await measure(
      () => Math.random(),
      config({ budget: { time: 30 } })
    );
    expect(sample.outerTime).toBeGreaterThanOrEqual(30e6);
    expect(sample.outerTime).toBeLessThan(1e9);
  });

  it('measures an auto budget for at least its minimum', async () => {
    const { sample } = await measure(
      () => Math.random(),
      config({ budget: { auto: { min: 20, max: 1000, runs: 10 } } })
    );
    expect(sample.outerTime).toBeGreaterThanOrEqual(20e6);
    expect(sample.outerTime).toBeLessThan(500e6);
  });

  it('reports progress', async () => {
    const progress = vi.fn();
    await measure(() => 1, config(), { progress });
    expect(progress).toHaveBeenCalledWith(0);
  });

  it('rejects when the function throws', async () => {
    await expect(
      measure(() => {
        throw new Error('boom');
      }, config())
    ).rejects.toThrow('boom');
  });
});

describe('sampleLimits', () => {
  it('limits runs or time', () => {
    expect(sampleLimits({ runs: 5 }, 100)).toEqual({ runs: 5, time: Infinity });
    expect(sampleLimits({ time: 2 }, 100)).toEqual({
      runs: Infinity,
      time: 2e6,
    });
  });

  it('chooses the auto time from the run time, within min and max', () => {
    const auto = { auto: { min: 1, max: 5, runs: 100 } };
    expect(sampleLimits(auto, 1000).time).toBe(1e6);
    expect(sampleLimits(auto, 20_000).time).toBe(2e6);
    expect(sampleLimits(auto, 1e6).time).toBe(5e6);
  });
});

describe('calibrate and trimmedMean', () => {
  it('leaves out the highest values', () => {
    expect(trimmedMean(Float64Array.of(100, 1, 3, 2), 0.25)).toBe(2);
    expect(trimmedMean(Float64Array.of(4), 0.5)).toBe(4);
  });

  it('measures a small, finite overhead', () => {
    const overhead = calibrate(1);
    expect(overhead).toBeGreaterThanOrEqual(0);
    expect(overhead).toBeLessThan(100_000);
  });
});
