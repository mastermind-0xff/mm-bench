import { describe, expect, it } from 'vitest';
import {
  MACHINE_SHARES,
  machineOf,
  sampleOf,
  ticksOf,
} from './fixtures/reports.js';
import {
  averageSeries,
  capWithCarry,
  caseSeries,
  cpuWindowOf,
  fillGaps,
  levels,
  rates,
  ratios,
} from './series.js';

describe('rates', () => {
  it('differentiates a counter per window', () => {
    expect(rates([0, 10, 20], [0, 5, 15], 2)).toEqual([0.5, 1]);
  });

  it('interpolates between ticks', () => {
    expect(rates([0, 10, 20], [0, 5, 15], 4)).toEqual([0.5, 0.5, 1, 1]);
  });

  it('gives NaN for an empty span', () => {
    expect(rates([0], [0], 2)).toEqual([NaN, NaN]);
    expect(rates([0, 0], [0, 1], 1)).toEqual([NaN]);
  });

  it('takes a span, for ticks starting before 0 and ending after it', () => {
    expect(rates([-10, 0, 10, 30], [0, 5, 10, 30], 2, 20)).toEqual([0.5, 1]);
  });
});

describe('levels', () => {
  it('takes the highest value per window', () => {
    expect(levels([0, 10, 20, 30], [1, 5, 2, 8], 3)).toEqual([1, 5, 8]);
  });

  it('interpolates windows without a tick', () => {
    expect(levels([0, 30], [0, 30], 3)).toEqual([0, 15, 30]);
  });
});

describe('ratios', () => {
  it('divides the deltas of two counters per window', () => {
    expect(ratios([0, 10, 20], [0, 100, 300], [0, 10, 20], 2)).toEqual([
      10, 20,
    ]);
  });

  it('gives NaN where the divisor did not change', () => {
    expect(ratios([0, 10, 20], [0, 100, 100], [0, 10, 10], 2)).toEqual([
      10,
      NaN,
    ]);
  });
});

describe('capWithCarry', () => {
  it('caps values, carrying the excess into the next one', () => {
    expect(capWithCarry([125, 75, 100, 110], 100)).toEqual([
      100, 100, 100, 100,
    ]);
    expect(capWithCarry([50, NaN, 130, 20], 100)).toEqual([50, NaN, 100, 50]);
  });
});

describe('averageSeries and fillGaps', () => {
  it('averages value by value, skipping NaN', () => {
    expect(
      averageSeries([
        [1, NaN, 3],
        [3, 4],
      ])
    ).toEqual([2, 4, 3]);
    expect(averageSeries([[NaN], [NaN]])).toEqual([NaN]);
  });

  it('fills gaps with the value before, the first with the one after', () => {
    expect(fillGaps([NaN, 2, NaN, 5, NaN])).toEqual([2, 2, 2, 5, 5]);
    expect(fillGaps([NaN, NaN])).toEqual([0, 0]);
  });
});

describe('caseSeries', () => {
  const sample = sampleOf({ durations: [2000], counts: [1000] });

  it('resamples and averages the samples', () => {
    const series = caseSeries([sample, sample], 4);
    expect(series.duration).toBe(2_000_000);
    expect(series.timeline).toEqual([2000, 2000, 2000, 2000]);
    expect(series.thread.map(Math.round)).toEqual([100, 100, 100, 100]);
    expect(series.cores.map((cores) => cores.toFixed(2))).toEqual([
      '1.00',
      '1.00',
      '1.00',
      '1.00',
    ]);
    expect(series.heapUsed).toHaveLength(4);
  });

  it('gives the heap above the first tick, the thread cost', () => {
    // 4, 5, 6, 4, 5, 6… MB
    const series = caseSeries([sample], 5);
    expect(series.heapBase).toBe(4 * 1024 ** 2);
    expect(series.heapDelta).toHaveLength(5);
    expect(Math.min(...series.heapDelta)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...series.heapDelta)).toBe(2 * 1024 ** 2);
    series.heapDelta.forEach((delta, index) => {
      expect(delta).toBe((series.heapUsed[index] ?? NaN) - series.heapBase);
    });
  });

  it('gives no thread series without thread CPU times', () => {
    const series = caseSeries(
      [{ ...sample, ticks: { ...sample.ticks, threadCpu: [] } }],
      4
    );
    expect(series.thread).toEqual([]);
  });

  it("gives each core's busy share over the sample", () => {
    const { machine } = caseSeries([sample, sample], 3, { machineWindow: 0 });
    expect(machine).toHaveLength(MACHINE_SHARES.length);
    machine.forEach((shares, core) => {
      expect(shares).toHaveLength(3);
      for (const share of shares)
        expect(share).toBeCloseTo((MACHINE_SHARES[core] ?? NaN) * 100, 6);
    });
  });

  it('measures the machine over windows of at least machineWindow', () => {
    const uneven = {
      ...sample,
      // core 0 busy in the first half only, from probes 0.5 ms apart
      machine: {
        time: [-500_000, 0, 500_000, 1_000_000, 1_500_000, 2_000_000],
        busy: [[0, 0.5, 1, 1.5, 1.5, 1.5]],
        idle: [[0, 0, 0, 0, 0.5, 1]],
      },
    };
    expect(caseSeries([uneven], 4, { machineWindow: 0 }).machine).toEqual([
      [100, 100, 0, 0],
    ]);
    expect(
      caseSeries([uneven], 4, { machineWindow: 2_000_000 }).machine
    ).toEqual([[50, 50, 50, 50]]);
  });

  it('gives no machine series when the OS reports no cores', () => {
    const series = caseSeries(
      [{ ...sample, machine: { time: [], busy: [], idle: [] } }],
      4
    );
    expect(series.machine).toEqual([]);
    expect(machineOf(1000).busy).toHaveLength(MACHINE_SHARES.length);
  });

  it('gives times per call, overhead subtracted', () => {
    expect(
      caseSeries([sample], 2, { batchSize: 4, shift: 100 }).timeline
    ).toEqual([400, 400]);
  });

  it('measures CPU over windows of at least cpuWindow', () => {
    const uneven = {
      ...sample,
      ticks: {
        ...ticksOf(1000, 2000, 4),
        // all the CPU time in the first half
        cpu: [0, 1000, 2000, 2000, 2000],
      },
    };
    expect(caseSeries([uneven], 4).cores.map(Math.round)).toEqual([2, 2, 0, 0]);
    expect(
      caseSeries([uneven], 4, { cpuWindow: 1_000_000 }).cores.map(Math.round)
    ).toEqual([2, 2, 0, 0]);
    expect(
      caseSeries([uneven], 4, { cpuWindow: 2_000_000 }).cores.map(Math.round)
    ).toEqual([1, 1, 1, 1]);
  });

  it('knows platforms with a coarse CPU clock', () => {
    expect(cpuWindowOf('win32')).toBe(62.5e6);
    expect(cpuWindowOf('linux')).toBe(0);
  });
});
