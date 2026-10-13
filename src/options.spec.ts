import { describe, expect, it } from 'vitest';
import {
  checkMeasureOptions,
  checkRunOptions,
  DEFAULT_AUTO_TIME,
  resolveMeasureOptions,
  sampleBudget,
} from './options.js';
import type { MeasureOptions } from './types.js';

describe('resolveMeasureOptions', () => {
  it('fills in the defaults', () => {
    expect(resolveMeasureOptions()).toEqual({
      time: DEFAULT_AUTO_TIME,
      samples: 4,
      warmup: { time: 100 },
      batchSize: 1,
      subtractOverhead: true,
      tickInterval: 10,
      timeout: 60_000,
    });
  });

  it('lets later levels win', () => {
    const resolved = resolveMeasureOptions(
      { samples: 2, batchSize: 5 },
      undefined,
      { samples: 3 }
    );
    expect(resolved).toMatchObject({ samples: 3, batchSize: 5 });
  });

  it('takes the budget from the last level that sets one', () => {
    expect(resolveMeasureOptions({ runs: 100 }, { time: 50 })).toMatchObject({
      time: 50,
    });
    const runs = resolveMeasureOptions({ time: 50 }, { runs: 100 });
    expect(runs).toMatchObject({ runs: 100 });
    expect('time' in runs).toBe(false);
    expect(resolveMeasureOptions({ runs: 100 }, { samples: 2 })).toMatchObject({
      runs: 100,
    });
  });

  it("resolves 'auto' and partial auto settings", () => {
    expect(resolveMeasureOptions({ time: 'auto' })).toMatchObject({
      time: DEFAULT_AUTO_TIME,
    });
    expect(resolveMeasureOptions({ time: { max: 3000 } })).toMatchObject({
      time: { min: 2000, max: 3000, runs: 10_000 },
    });
    // a min above the default max raises the max with it
    expect(resolveMeasureOptions({ time: { min: 20_000 } })).toMatchObject({
      time: { min: 20_000, max: 20_000, runs: 10_000 },
    });
  });

  it('accepts an endless timeout and zero warm-up', () => {
    expect(
      resolveMeasureOptions({ timeout: Infinity, warmup: { runs: 0 } })
    ).toMatchObject({ timeout: Infinity, warmup: { runs: 0 } });
  });

  it('rejects time and runs in the same options', () => {
    expect(() => resolveMeasureOptions({ time: 1, runs: 1 } as never)).toThrow(
      TypeError
    );
  });

  it.each([
    { samples: 0 },
    { samples: 1.5 },
    { runs: 0 },
    { time: -1 },
    { time: Number.NaN },
    { time: Infinity },
    { time: 'fast' },
    { time: { min: 5, max: 1 } },
    { time: { runs: 0 } },
    { warmup: { time: 1, runs: 1 } },
    { warmup: 100 },
    { batchSize: 0 },
    { tickInterval: 0 },
    { timeout: 0 },
    { subtractOverhead: 'yes' },
  ])('rejects %j', (options) => {
    expect(() => resolveMeasureOptions(options as never)).toThrow(RangeError);
  });

  it('rejects unknown auto settings and non-objects', () => {
    expect(() => resolveMeasureOptions({ time: { mx: 1 } } as never)).toThrow(
      TypeError
    );
    expect(() => resolveMeasureOptions(5 as never)).toThrow(TypeError);
  });
});

describe('checkMeasureOptions and checkRunOptions', () => {
  it('accept known options', () => {
    expect(() => {
      checkMeasureOptions({ runs: 1, samples: 1 });
    }).not.toThrow();
    expect(() => {
      checkRunOptions({ runs: 1, file: 'x', root: '.', output: false });
    }).not.toThrow();
    expect(() => {
      checkMeasureOptions(undefined);
    }).not.toThrow();
  });

  it('reject unknown options, with their name', () => {
    expect(() => {
      checkMeasureOptions({ tme: 1 });
    }).toThrow(/'tme'/);
    expect(() => {
      checkMeasureOptions({ file: 'x' });
    }).toThrow(TypeError);
    expect(() => {
      checkRunOptions({ outptu: false });
    }).toThrow(/'outptu'/);
  });
});

describe('sampleBudget', () => {
  const split = (options: MeasureOptions) => {
    const resolved = resolveMeasureOptions(options);
    return Array.from({ length: resolved.samples }, (_, sample) =>
      sampleBudget(resolved, sample)
    );
  };

  it('splits runs evenly, the first samples taking the remainder', () => {
    expect(split({ runs: 10, samples: 4 })).toEqual([
      { runs: 3 },
      { runs: 3 },
      { runs: 2 },
      { runs: 2 },
    ]);
  });

  it('gives every sample at least one run', () => {
    expect(split({ runs: 2, samples: 4 })).toEqual(
      Array.from({ length: 4 }, () => ({ runs: 1 }))
    );
  });

  it('splits time and auto settings', () => {
    expect(split({ time: 1000, samples: 4 })[0]).toEqual({ time: 250 });
    expect(
      split({ time: { min: 2000, max: 8000, runs: 10 }, samples: 4 })[0]
    ).toEqual({ auto: { min: 500, max: 2000, runs: 3 } });
  });
});
