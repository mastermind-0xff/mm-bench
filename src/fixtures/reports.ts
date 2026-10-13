/**
 * Builders of synthetic reports for tests: real `buildReport`, made-up
 * samples. Not part of the package.
 */
import { resolveMeasureOptions } from '../options.js';
import { buildReport } from '../report.js';
import type {
  Environment,
  Histogram,
  MachineTicks,
  MeasureOptions,
  Report,
  SampleReport,
  Ticks,
} from '../types.js';

export const environmentOf = (timerResolution = 1): Environment => ({
  node: 'v22.0.0',
  v8: '12.4',
  platform: 'linux',
  arch: 'x64',
  cpu: 'Test CPU',
  cores: 4,
  timerResolution,
});

/**
 * Ticks of a sample that ran `runs` runs of `runTime` ns evenly, at 100%
 * CPU, `steps` ticks apart.
 */
export const ticksOf = (runs: number, runTime: number, steps = 10): Ticks => {
  const indexes = Array.from({ length: steps + 1 }, (_, index) => index);
  const time = indexes.map((index) => (index * runs * runTime) / steps);
  return {
    time,
    runs: indexes.map((index) => (index * runs) / steps),
    innerTime: time,
    cpu: time.map((ns) => ns / 1000),
    threadCpu: time.map((ns) => ns / 1000),
    rss: indexes.map(() => 50 * 1024 ** 2),
    heapUsed: indexes.map((index) => (4 + (index % 3)) * 1024 ** 2),
  };
};

/** Busy share of each core in `machineOf`'s probes. */
export const MACHINE_SHARES = [1, 0.5, 0.25, 0];

/**
 * Probes of a machine whose cores are busy by `shares` during `duration`
 * ns, starting a probe before it and ending one after it.
 */
export const machineOf = (
  duration: number,
  steps = 10,
  shares: readonly number[] = MACHINE_SHARES
): MachineTicks => {
  const step = duration / steps;
  const indexes = Array.from({ length: steps + 3 }, (_, index) => index);
  // milliseconds since the first probe
  const elapsed = indexes.map((index) => (index * step) / 1e6);
  return {
    time: indexes.map((index) => (index - 1) * step),
    busy: shares.map((share) => elapsed.map((ms) => ms * share)),
    idle: shares.map((share) => elapsed.map((ms) => ms * (1 - share))),
  };
};

export const sampleOf = (histogram: Histogram, overhead = 0): SampleReport => {
  const runs = histogram.counts.reduce((sum, count) => sum + count, 0);
  const innerTime = histogram.durations.reduce(
    (sum, duration, index) => sum + duration * (histogram.counts[index] ?? 0),
    0
  );
  return {
    runs,
    overhead,
    innerTime,
    outerTime: innerTime * 1.1,
    histogram,
    ticks: ticksOf(runs, innerTime / runs),
    machine: machineOf(innerTime),
  };
};

export interface CaseSpec {
  readonly name: string;
  readonly durations: readonly number[];
  readonly counts: readonly number[];
  readonly overhead?: number;
  readonly options?: MeasureOptions;
  readonly async?: boolean;
}

/** A report of cases with one sample each. */
export const reportOf = (
  cases: readonly CaseSpec[],
  timerResolution = 1
): Report =>
  buildReport(
    cases.map(
      ({ name, durations, counts, overhead = 0, options, async = false }) => ({
        name,
        options: resolveMeasureOptions(options),
        measurements: [
          { async, sample: sampleOf({ durations, counts }, overhead) },
        ],
      })
    ),
    environmentOf(timerResolution),
    0
  );
