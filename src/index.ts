/**
 * mm-bench: microbenchmarks with run time distributions.
 *
 * ```ts
 * // bench/strings.js, run with `node bench/strings.js`
 * import { bench, compare } from 'mm-bench';
 *
 * // prepared at the top level: the workers run this file too
 * const words = Array.from({ length: 50 }, (_, index) => `word${index}`);
 *
 * await compare(
 *   bench('join', () => words.join(' ')),
 *   bench('reduce', () => words.reduce((text, word) => `${text}${word} `, ''))
 * );
 *
 * // each call is its own comparison, measured after the previous one
 * const report = await compare(
 *   bench('upper', () => words.map((word) => word.toUpperCase())),
 *   bench('lower', () => words.map((word) => word.toLowerCase())),
 *   { runs: 1_000_000, output: false }
 * );
 * report.cases[0]?.histogram; // raw data
 * ```
 */
export { bench, compare, isWorker } from './bench.js';
export { DEFAULT_BUCKETS, DEFAULT_TRIM, distribution } from './distribution.js';
export { DEFAULT_AUTO_TIME, DEFAULT_MEASURE_OPTIONS } from './options.js';
export {
  DEFAULT_GRAPHS,
  DEFAULT_SUMMARY,
  GRAPH_NAMES,
  loggerReporter,
  SUMMARY_FIELDS,
} from './reporter.js';
export {
  caseSeries,
  MACHINE_WINDOW,
  type CaseSeries,
  type CaseSeriesOptions,
} from './series.js';
export { computeStats } from './stats.js';
export { mergeHistograms } from './recorder.js';
export type * from './types.js';
