import type {
  AutoTime,
  MeasureOptions,
  ResolvedMeasureOptions,
  RunOptions,
  Span,
} from './types.js';

/** `time: 'auto'` settings, see `AutoTime`. */
export const DEFAULT_AUTO_TIME: Readonly<Required<AutoTime>> = Object.freeze({
  min: 2000,
  max: 10_000,
  runs: 10_000,
});

/** Options of a case that sets none. */
export const DEFAULT_MEASURE_OPTIONS: ResolvedMeasureOptions = Object.freeze({
  time: DEFAULT_AUTO_TIME,
  samples: 4,
  warmup: Object.freeze({ time: 100 }),
  batchSize: 1,
  subtractOverhead: true,
  tickInterval: 10,
  timeout: 60_000,
});

const MEASURE_KEYS: ReadonlySet<string> = new Set([
  'time',
  'runs',
  'samples',
  'warmup',
  'batchSize',
  'subtractOverhead',
  'tickInterval',
  'timeout',
]);
const CALL_KEYS: ReadonlySet<string> = new Set(['file', 'root', 'output']);

/**
 * Budget of one sample: its share of the case's runs or time, or the
 * shares of `AutoTime` it chooses its time from.
 */
export type SampleBudget =
  | { readonly runs: number }
  | { readonly time: number }
  | { readonly auto: Readonly<Required<AutoTime>> };

const describe = (value: unknown): string =>
  typeof value === 'string' ? `'${value}'`
  : typeof value === 'number' || typeof value === 'boolean' ? String(value)
  : value === null ? 'null'
  : typeof value;

const fail = (name: string, expected: string, value: unknown): never => {
  throw new RangeError(
    `mm-bench: ${name} must be ${expected}, got ${describe(value)}.`
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const integer = (name: string, value: unknown, min: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min ?
    value
  : fail(name, `an integer of at least ${String(min)}`, value);

/** A positive or zero (`allowZero`) number; `Infinity` only if allowed. */
const positive = (
  name: string,
  value: unknown,
  { allowZero = false, allowInfinity = false } = {}
): number =>
  (
    typeof value === 'number' &&
    (allowInfinity ? !Number.isNaN(value) : Number.isFinite(value)) &&
    (allowZero ? value >= 0 : value > 0)
  ) ?
    value
  : fail(
      name,
      allowZero ? 'a number of at least 0' : 'a positive number',
      value
    );

const checkKeys = (
  options: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string
): void => {
  for (const key of Object.keys(options))
    if (!allowed.has(key))
      throw new TypeError(`mm-bench: unknown ${name} option '${key}'.`);
};

const resolveSpan = (name: string, value: unknown): Span => {
  if (!isRecord(value) || 'time' in value === 'runs' in value)
    return fail(name, '{ time } or { runs }', value);
  return 'time' in value ?
      { time: positive(`${name}.time`, value.time, { allowZero: true }) }
    : { runs: integer(`${name}.runs`, value.runs, 0) };
};

const resolveTime = (value: unknown): number | Required<AutoTime> => {
  if (value === 'auto') return DEFAULT_AUTO_TIME;
  if (typeof value === 'number') return positive('time', value);
  if (!isRecord(value))
    return fail('time', "a number, 'auto' or { min, max, runs }", value);
  checkKeys(value, new Set(['min', 'max', 'runs']), 'time');
  const min =
    value.min === undefined ?
      DEFAULT_AUTO_TIME.min
    : positive('time.min', value.min, { allowZero: true });
  const max =
    value.max === undefined ?
      Math.max(min, DEFAULT_AUTO_TIME.max)
    : positive('time.max', value.max);
  if (max < min)
    throw new RangeError(
      `mm-bench: time.max (${String(max)}) is below time.min (${String(min)}).`
    );
  const runs =
    value.runs === undefined ?
      DEFAULT_AUTO_TIME.runs
    : integer('time.runs', value.runs, 1);
  return { min, max, runs };
};

/**
 * Merges levels of measure options, later levels winning: defaults, then
 * the call's options, then the case's. A level that sets `time` or `runs`
 * sets the budget.
 *
 * @throws TypeError for unknown options or `time` and `runs` together,
 * RangeError for invalid values.
 */
export const resolveMeasureOptions = (
  ...levels: readonly (MeasureOptions | RunOptions | undefined)[]
): ResolvedMeasureOptions => {
  let budget: { time: number | Required<AutoTime> } | { runs: number } = {
    time: DEFAULT_AUTO_TIME,
  };
  let { samples, warmup, batchSize, subtractOverhead, tickInterval, timeout } =
    DEFAULT_MEASURE_OPTIONS;
  for (const level of levels) {
    if (level === undefined) continue;
    if (!isRecord(level))
      throw new TypeError(
        `mm-bench: options must be an object, got ${describe(level)}.`
      );
    const {
      time,
      runs,
      samples: levelSamples,
      warmup: levelWarmup,
      batchSize: levelBatchSize,
      subtractOverhead: levelSubtract,
      tickInterval: levelTickInterval,
      timeout: levelTimeout,
    } = level;
    if (time !== undefined && runs !== undefined)
      throw new TypeError(
        'mm-bench: set either time or runs, not both in the same options.'
      );
    if (time !== undefined) budget = { time: resolveTime(time) };
    if (runs !== undefined) budget = { runs: integer('runs', runs, 1) };
    if (levelSamples !== undefined)
      samples = integer('samples', levelSamples, 1);
    if (levelWarmup !== undefined) warmup = resolveSpan('warmup', levelWarmup);
    if (levelBatchSize !== undefined)
      batchSize = integer('batchSize', levelBatchSize, 1);
    if (levelSubtract !== undefined)
      subtractOverhead =
        typeof levelSubtract === 'boolean' ? levelSubtract : (
          fail('subtractOverhead', 'a boolean', levelSubtract)
        );
    if (levelTickInterval !== undefined)
      tickInterval = positive('tickInterval', levelTickInterval);
    if (levelTimeout !== undefined)
      timeout = positive('timeout', levelTimeout, { allowInfinity: true });
  }
  return {
    ...budget,
    samples,
    warmup,
    batchSize,
    subtractOverhead,
    tickInterval,
    timeout,
  };
};

/**
 * Checks the keys of a case's options.
 *
 * @throws TypeError for unknown options.
 */
export const checkMeasureOptions = (options: unknown): void => {
  if (options === undefined) return;
  if (!isRecord(options))
    throw new TypeError(
      `mm-bench: options must be an object, got ${describe(options)}.`
    );
  checkKeys(options, MEASURE_KEYS, 'bench');
};

/**
 * Checks the keys of a call's options.
 *
 * @throws TypeError for unknown options.
 */
export const checkRunOptions = (options: unknown): void => {
  if (options === undefined) return;
  if (!isRecord(options))
    throw new TypeError(
      `mm-bench: options must be an object, got ${describe(options)}.`
    );
  checkKeys(
    options,
    new Set([...MEASURE_KEYS, ...CALL_KEYS]),
    'run and compare'
  );
};

/**
 * Share of sample `sample` (from `0`) in its case's budget. Runs are split
 * as evenly as possible, the first samples taking the remainder, and each
 * sample makes at least one.
 */
export const sampleBudget = (
  options: ResolvedMeasureOptions,
  sample: number
): SampleBudget => {
  const { samples } = options;
  if ('runs' in options) {
    const share =
      Math.floor(options.runs / samples) +
      (sample < options.runs % samples ? 1 : 0);
    return { runs: Math.max(1, share) };
  }
  if (typeof options.time === 'number') return { time: options.time / samples };
  const { min, max, runs } = options.time;
  return {
    auto: {
      min: min / samples,
      max: max / samples,
      runs: Math.ceil(runs / samples),
    },
  };
};
