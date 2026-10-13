import { mergeHistograms } from './recorder.js';
import { computeStats } from './stats.js';
import type {
  CaseReport,
  Environment,
  Report,
  ResolvedMeasureOptions,
  SampleReport,
} from './types.js';

/** A measured sample: the worker's measurement and the machine's probes. */
export interface MeasuredSample {
  /** Whether calls returned a promise and were awaited. */
  readonly async: boolean;
  readonly sample: SampleReport;
}

/** A measured case: its name, options and samples. */
export interface MeasuredCase {
  readonly name: string;
  readonly options: ResolvedMeasureOptions;
  readonly measurements: readonly MeasuredSample[];
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

/** Mean of a case relative to the fastest mean. */
const relativeTo = (value: number, fastest: number): number =>
  fastest > 0 ? value / fastest
  : value > 0 ? Infinity
  : 1;

/** Turns measured samples into a report: merged histograms and stats. */
export const buildReport = (
  cases: readonly MeasuredCase[],
  environment: Environment,
  duration: number
): Report => {
  const reports = cases.map(({ name, options, measurements }) => {
    const samples = measurements.map(({ sample }) => sample);
    const histogram = mergeHistograms(
      samples.map((sample) => sample.histogram)
    );
    const overhead = mean(samples.map((sample) => sample.overhead));
    const stats = computeStats(
      histogram,
      options.subtractOverhead ? overhead : 0
    );
    return {
      name,
      async: measurements.some((measurement) => measurement.async),
      options,
      stats,
      overhead,
      histogram,
      samples,
    };
  });
  const fastest = Math.min(...reports.map(({ stats }) => stats.mean));
  return {
    cases: reports.map(
      ({ overhead, histogram, samples, ...head }): CaseReport => ({
        ...head,
        relative: relativeTo(head.stats.mean, fastest),
        overhead,
        histogram,
        samples,
      })
    ),
    environment,
    duration,
  };
};
