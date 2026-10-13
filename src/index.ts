/**
 * mm-bench: microbenchmarks with run time distributions.
 *
 * ```ts
 * // bench/style.js, run with `node bench/style.js`
 * import { bench, compare } from 'mm-bench';
 * import { sec as sec2 } from '../dist/esm/index.js';
 * import { sec as sec1 } from 'style-escape-codes';
 *
 * await compare(
 *   bench('v2', () => sec2.b.u.o.red('Hello')),
 *   bench('v1', () => sec1.b.u.o.red('Hello'))
 * );
 *
 * // each call is its own comparison, measured after the previous one
 * const report = await compare(
 *   bench('v2 nested', () => sec2.red(`Hello ${sec2.blue('blue')} hello.`)),
 *   bench('v1 nested', () => sec1.red(`Hello ${sec1.blue('blue')} hello.`)),
 *   { runs: 1_000_000, output: false }
 * );
 * report.cases[0]?.histogram; // raw data
 * ```
 */
export { bench, compare, isWorker } from './bench.js';
export { DEFAULT_BUCKETS, DEFAULT_TRIM, distribution } from './distribution.js';
export { DEFAULT_AUTO_TIME, DEFAULT_MEASURE_OPTIONS } from './options.js';
export { DEFAULT_GRAPHS, GRAPH_NAMES, loggerReporter } from './reporter.js';
export {
  caseSeries,
  MACHINE_WINDOW,
  type CaseSeries,
  type CaseSeriesOptions,
} from './series.js';
export { computeStats } from './stats.js';
export { mergeHistograms } from './recorder.js';
export type * from './types.js';
