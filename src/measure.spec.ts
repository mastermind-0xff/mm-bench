import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  calibrate,
  collectGarbage,
  meanWithoutOutliers,
  measure,
  progressInterval,
  sampleLimits,
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

const hasThreadCpuUsage =
  typeof (process as { threadCpuUsage?: unknown }).threadCpuUsage ===
  'function';

/** A case that keeps the thread busy for `ms` milliseconds. */
const busy = (ms: number) => (): number => {
  const end = performance.now() + ms;
  let spins = 0;
  while (performance.now() < end) spins++;
  return spins;
};

type MeasureModule = typeof import('./measure.js');

const requireBuilt = createRequire(import.meta.url);
/** The built module (`npm test` builds first), as the package ships it. */
const builds: Record<string, () => Promise<MeasureModule>> = {
  esm: async () =>
    (await import(
      new URL('../dist/esm/measure.js', import.meta.url).href
    )) as MeasureModule,
  cjs: () =>
    Promise.resolve(
      requireBuilt(
        fileURLToPath(new URL('../dist/cjs/measure.cjs', import.meta.url))
      ) as MeasureModule
    ),
};

describe('the build', () => {
  // the sources store every result in `sink`, so V8 can't drop the calls
  // as dead code; a bundler that drops the stores measures something else
  it.each(Object.keys(builds))(
    'stores the results of sync and async calls in sink (%s)',
    async (format) => {
      const built = await (builds[format] as () => Promise<MeasureModule>)();
      const result = { measured: true };
      const quick = config({ budget: { runs: 3 }, warmup: { runs: 2 } });
      await built.measure(() => result, quick);
      expect(built.sink).toBe(result);
      const later = { awaited: true };
      await built.measure(() => Promise.resolve(later), quick);
      expect(built.sink).toBe(later);
      // the empty calls timing the overhead are stored too
      built.calibrate(2);
      expect(built.sink).toBeUndefined();
    }
  );
});

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
      ticks.rss,
      ticks.heapUsed,
    ])
      expect(column).toHaveLength(ticks.time.length);
    // empty on Node versions without process.threadCpuUsage
    expect(ticks.threadCpu).toHaveLength(
      hasThreadCpuUsage ? ticks.time.length : 0
    );
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
    // a fast case gets the minimum, far from the maximum
    expect(sample.outerTime).toBeLessThan(1000e6);
  });

  it('reports progress', async () => {
    const progress = vi.fn();
    await measure(() => 1, config(), { progress });
    expect(progress).toHaveBeenCalledWith(0);
  });

  it('reports progress while warming up, within the timeout', async () => {
    const progress = vi.fn();
    // a 50 ms warm-up and progress every 10 ms, a quarter of the timeout
    await measure(
      busy(5),
      config({ budget: { runs: 2 }, warmup: { runs: 10 }, timeout: 40 }),
      { progress }
    );
    const starting = progress.mock.calls.filter(([runs]) => runs === 0);
    expect(starting.length).toBeGreaterThanOrEqual(3);
  });

  it('reports progress more often than ticks when the timeout is short', async () => {
    const progress = vi.fn();
    await measure(
      busy(2),
      config({
        budget: { runs: 20 },
        warmup: { runs: 0 },
        tickInterval: 10_000,
        timeout: 20,
      }),
      { progress }
    );
    expect(progress.mock.calls.some(([runs]) => (runs as number) > 0)).toBe(
      true
    );
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

describe('progressInterval', () => {
  it('reports four times per timeout, from 1 ms to 250 ms', () => {
    expect(progressInterval()).toBe(250_000_000n);
    expect(progressInterval(Infinity)).toBe(250_000_000n);
    expect(progressInterval(60_000)).toBe(250_000_000n);
    expect(progressInterval(400)).toBe(100_000_000n);
    expect(progressInterval(2)).toBe(1_000_000n);
  });
});

describe('meanWithoutOutliers', () => {
  const repeat = (value: number, count: number): number[] =>
    Array.from({ length: count }, () => value);

  it('keeps the readings one timer step up', () => {
    // a 100 ns timer and a 55 ns cost: 45% of the runs read 0, 55% 100
    const coarse = [...repeat(0, 45), ...repeat(100, 55)];
    expect(meanWithoutOutliers(Float64Array.from(coarse))).toBeCloseTo(55);
    // a 3 ns cost: no spread between the quartiles, the step counts
    const rare = [...repeat(0, 97), ...repeat(100, 3)];
    expect(meanWithoutOutliers(Float64Array.from(rare))).toBeCloseTo(3);
  });

  it('leaves out interrupts', () => {
    const coarse = [...repeat(0, 45), ...repeat(100, 54), 50_000];
    expect(meanWithoutOutliers(Float64Array.from(coarse))).toBeCloseTo(
      5400 / 99
    );
    const fine = [20, 21, 22, 23, 24, 25, 26, 27, 5000];
    expect(meanWithoutOutliers(Float64Array.from(fine))).toBe(23.5);
  });

  it('handles equal and no values', () => {
    expect(meanWithoutOutliers(Float64Array.of(4, 4))).toBe(4);
    expect(meanWithoutOutliers(new Float64Array(0))).toBe(0);
  });
});

describe('calibrate', () => {
  it('measures a small, finite overhead', () => {
    const overhead = calibrate(1);
    expect(overhead).toBeGreaterThanOrEqual(0);
    expect(overhead).toBeLessThan(100_000);
  });

  it('takes about 100 ms at most, however big the batch', () => {
    // uncapped, 15,000 runs of a million calls take many seconds
    const start = performance.now();
    expect(calibrate(1_000_000)).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('reports progress between runs', () => {
    const progress = vi.fn();
    calibrate(1000, progress, 1n);
    expect(progress).toHaveBeenCalled();
  });
});
