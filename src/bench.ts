import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { environment } from './environment.js';
import { resolveBenchFile, type BenchFile } from './file.js';
import { escapeControls } from './format.js';
import { measure } from './measure.js';
import {
  checkMeasureOptions,
  checkRunOptions,
  resolveMeasureOptions,
  sampleBudget,
} from './options.js';
import {
  describeError,
  REACHED_KEY,
  TASK_KEY,
  type WorkerMessage,
  type WorkerTask,
} from './protocol.js';
import { buildReport, type MeasuredSample } from './report.js';
import { loggerReporter } from './reporter.js';
import { runSample } from './runner.js';
import type {
  Bench,
  BenchFn,
  BenchFunction,
  CompareFunction,
  MeasureOptions,
  Report,
  Reporter,
  ResolvedMeasureOptions,
  RunOptions,
} from './types.js';

/** Brand of cases, shared by module copies (ESM and CJS). */
const BENCH = Symbol.for('mm-bench.bench');

class BenchCase implements Bench {
  readonly [BENCH] = true;

  constructor(
    readonly name: string,
    readonly fn: BenchFn,
    readonly options: MeasureOptions
  ) {}

  run(options: RunOptions = {}): Promise<Report> {
    return compare(this, options);
  }
}

const isBench = (value: unknown): value is BenchCase =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<symbol, unknown>)[BENCH] === true;

/**
 * The task of this thread when it is a measuring worker, `undefined` on the
 * main thread and in other workers.
 */
const workerTask = (): WorkerTask | undefined => {
  if (isMainThread) return undefined;
  const data = workerData as Record<string, unknown> | null | undefined;
  const task = data?.[TASK_KEY];
  return typeof task === 'object' && task !== null ?
      (task as WorkerTask)
    : undefined;
};

/**
 * Whether this code runs in one of mm-bench's measuring workers, which run
 * the bench file again to get the cases. Use it to skip work the cases
 * don't need, like writing files; data the cases use must still be
 * prepared.
 */
export const isWorker = (): boolean => workerTask() !== undefined;

export const bench: BenchFunction = (name, fn, options) => {
  if (typeof name !== 'string' || name === '')
    throw new TypeError('mm-bench: a case needs a name.');
  if (typeof fn !== 'function')
    throw new TypeError(
      `mm-bench: case "${escapeControls(name)}" needs a function, got ${typeof fn}.`
    );
  checkMeasureOptions(options);
  // values are checked now, where the mistake is
  resolveMeasureOptions(options);
  return new BenchCase(name, fn, options ?? {});
};

/** Calls so far, by file: the workers find their call by this index. */
const calls = new Map<string, number>();
/** Calls run one at a time: the end of the last one queued. */
let queue: Promise<unknown> = Promise.resolve();

const nextCall = (file: BenchFile): number => {
  const call = calls.get(file.url) ?? 0;
  calls.set(file.url, call + 1);
  return call;
};

const resolveReporter = (
  output: RunOptions['output']
): Reporter | undefined => {
  if (output === undefined || output === true) return loggerReporter();
  if (output === false) return undefined;
  if (typeof output === 'object' && (output as unknown) !== null) return output;
  throw new TypeError(
    `mm-bench: output must be a boolean or a reporter, got ${typeof output}.`
  );
};

const parseArguments = (
  args: readonly unknown[]
): { cases: BenchCase[]; options: RunOptions } => {
  const last = args.at(-1);
  const hasOptions = args.length > 0 && !isBench(last);
  checkRunOptions(hasOptions ? last : undefined);
  const options = (hasOptions ? last : undefined) as RunOptions | undefined;
  const cases = hasOptions ? args.slice(0, -1) : args;
  if (cases.length === 0)
    throw new TypeError(
      'mm-bench: nothing to measure: pass cases created by bench().'
    );
  const names = new Set<string>();
  return {
    cases: cases.map((value, index) => {
      if (!isBench(value))
        throw new TypeError(
          `mm-bench: argument ${String(index + 1)} is not a case created by bench().`
        );
      if (names.has(value.name))
        throw new TypeError(
          `mm-bench: two cases are named "${escapeControls(value.name)}": names must be unique.`
        );
      names.add(value.name);
      return value;
    }),
    options: options ?? {},
  };
};

/** Measures the task's case in this worker and posts the result. */
const measureInWorker = async (
  task: WorkerTask,
  cases: readonly BenchCase[]
): Promise<never> => {
  const post = (message: WorkerMessage): void => {
    parentPort?.postMessage(message);
  };
  const names = cases.map(({ name }) => name);
  const target = cases[task.case];
  const list = (each: readonly string[]): string =>
    each.map(escapeControls).join(', ');
  if (target === undefined || names.join('\0') !== task.names.join('\0'))
    post({
      type: 'error',
      message: `the worker reached a call with other cases (${list(names)}) than the main thread (${list(task.names)}). Cases must be the same on every run of the file.`,
    });
  else {
    post({ type: 'progress', runs: 0 });
    try {
      const { options, budget } = task;
      const { async, sample, start } = await measure(
        target.fn,
        { budget, ...options },
        {
          progress: (runs) => {
            post({ type: 'progress', runs });
          },
        }
      );
      post({ type: 'result', async, sample, start });
    } catch (error) {
      post({ type: 'error', ...describeError(error) });
    }
  }
  // the main thread stops this worker: code after the call never runs
  return new Promise<never>(() => undefined);
};

/** Runs a call's samples in workers, interleaving the cases. */
const measureCall = async (
  cases: readonly BenchCase[],
  resolved: readonly ResolvedMeasureOptions[],
  file: BenchFile,
  call: number,
  reporter: Reporter | undefined
): Promise<Report> => {
  const started = performance.now();
  const env = environment();
  const names = cases.map(({ name }) => name);
  await reporter?.start?.({
    cases: cases.map(({ name }, index) => ({
      name,
      options: resolved[index] as ResolvedMeasureOptions,
    })),
    environment: env,
  });
  const measurements: MeasuredSample[][] = cases.map(() => []);
  const rounds = Math.max(...resolved.map(({ samples }) => samples));
  let order = cases.map((_, index) => index);
  for (let sample = 0; sample < rounds; sample++) {
    for (const index of order) {
      const options = resolved[index] as ResolvedMeasureOptions;
      const name = names[index] as string;
      if (sample >= options.samples) continue;
      const measurement = await runSample(
        {
          file: file.url,
          entry: process.argv[1],
          call,
          case: index,
          names,
          sample,
          budget: sampleBudget(options, sample),
          options,
          environment: env,
        },
        { name, timeout: options.timeout }
      );
      measurements[index]?.push(measurement);
      await reporter?.sample?.({
        case: name,
        sample: sample + 1,
        samples: options.samples,
        async: measurement.async,
        result: measurement.sample,
      });
    }
    order = order.toReversed();
  }
  const report = buildReport(
    cases.map(({ name }, index) => ({
      name,
      options: resolved[index] as ResolvedMeasureOptions,
      measurements: measurements[index] ?? [],
    })),
    env,
    performance.now() - started
  );
  await reporter?.end?.(report);
  return report;
};

const start = (args: readonly unknown[]): Promise<Report> => {
  const { cases, options } = parseArguments(args);
  const task = workerTask();
  const file = resolveBenchFile(options.file ?? task?.entry, options.root);
  const call = nextCall(file);
  if (task !== undefined) {
    if (task.file !== file.url || task.call !== call)
      // an earlier call: the worker goes on to the one it measures
      return Promise.resolve({
        cases: [],
        environment: task.environment,
        duration: 0,
      });
    (globalThis as Record<symbol, unknown>)[Symbol.for(REACHED_KEY)] = true;
    return measureInWorker(task, cases);
  }
  const resolved = cases.map((value) =>
    resolveMeasureOptions(options, value.options)
  );
  const reporter = resolveReporter(options.output);
  const result = queue.then(() =>
    measureCall(cases, resolved, file, call, reporter)
  );
  queue = result.catch(() => undefined);
  return result;
};

export const compare: CompareFunction = (...args: unknown[]) => {
  try {
    return start(args);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error))
    );
  }
};
