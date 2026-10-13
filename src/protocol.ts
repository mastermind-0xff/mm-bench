import type { WorkerSample } from './measure.js';
import type { SampleBudget } from './options.js';
import type { Environment, ResolvedMeasureOptions } from './types.js';

/**
 * Messages between the main thread and the workers. Types only: the worker
 * entry imports nothing at runtime, so it starts fast and runs from the
 * TypeScript sources too.
 */

/** Key of the task in `workerData`. */
export const TASK_KEY = 'mmBench';

/**
 * `Symbol.for` key of the global flag set once a worker reaches the call it
 * measures. A global, so module copies (ESM and CJS) share it.
 */
export const REACHED_KEY = 'mm-bench.reached';

/** What a worker measures. */
export interface WorkerTask {
  /** `file:` URL of the file to import, see `resolveBenchFile`. */
  readonly file: string;
  /**
   * The main thread's entry script, the default `file`: in a worker,
   * `process.argv[1]` is the worker's own entry.
   */
  readonly entry: string | undefined;
  /** Index of the call among the calls passing the same file. */
  readonly call: number;
  /** Index of the measured case in the call. */
  readonly case: number;
  /** Names of the call's cases, to check the worker reached the same call. */
  readonly names: readonly string[];
  /** Index of the sample, from `0`. */
  readonly sample: number;
  readonly budget: SampleBudget;
  readonly options: ResolvedMeasureOptions;
  /**
   * The main thread's environment, for the empty reports of earlier calls:
   * a worker doesn't spend time measuring the timer again.
   */
  readonly environment: Environment;
}

export type WorkerMessage =
  /** The worker is alive and measuring; `runs` so far. */
  | { readonly type: 'progress'; readonly runs: number }
  | {
      readonly type: 'result';
      readonly async: boolean;
      readonly sample: WorkerSample;
      /** `hrtime` when measuring started, see `Measurement`. */
      readonly start: bigint;
    }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly stack?: string | undefined;
    }
  /** The file was imported but never made the measured call. */
  | { readonly type: 'not-reached' };

/** A thrown value as a message, without throwing on odd values. */
export const describeError = (
  error: unknown
): { message: string; stack?: string | undefined } => {
  try {
    if (error instanceof Error)
      return { message: `${error.name}: ${error.message}`, stack: error.stack };
    return { message: String(error) };
  } catch {
    return { message: 'unknown error' };
  }
};
