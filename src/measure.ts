import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { SampleBudget } from './options.js';
import { Recorder } from './recorder.js';
import type { BenchFn, SampleReport, Span, Ticks } from './types.js';

const hrtime = (): bigint => process.hrtime.bigint();

/** Empty runs that warm the calibration up, until the JIT has optimized it. */
const CALIBRATION_WARMUP = 10_000;
/** Empty runs timed to measure the timer overhead. */
export const CALIBRATION_RUNS = 5000;
/**
 * Most nanoseconds each calibration phase (warm-up, timed runs) takes: big
 * batches reach it in fewer runs, and their runs are long enough for a
 * precise mean anyway.
 */
const CALIBRATION_TIME = 50_000_000n;
/** Tukey's far-out fence: values above Q3 + 3 × IQR are outliers. */
const FENCE = 3;
/** Most nanoseconds between progress reports. */
const PROGRESS_INTERVAL = 250_000_000n;
/** Fewest nanoseconds between progress reports, for very short timeouts. */
const MIN_PROGRESS_INTERVAL = 1_000_000n;
/** A deadline no sample reaches: about 146 years. */
const NEVER = 1n << 62n;

/**
 * Results of the measured calls, kept so V8 can't drop the calls as dead
 * code. Nothing reads it: the build must keep the stores (see
 * rollup.config.js).
 */
export let sink: unknown;

export interface MeasureConfig {
  /** This sample's budget, see `sampleBudget`. */
  readonly budget: SampleBudget;
  readonly warmup: Span;
  readonly batchSize: number;
  /** Milliseconds between ticks. */
  readonly tickInterval: number;
  /**
   * Milliseconds the main thread waits for progress before it stops the
   * worker, see `progressInterval`. Default: none.
   */
  readonly timeout?: number;
}

export interface MeasureHooks {
  /**
   * Called with the runs so far (`0` while calibrating and warming up), at
   * most every `progressInterval(timeout)`, between runs.
   */
  readonly progress?: (runs: number) => void;
}

/** A sample as the worker measures it: the main thread adds `machine`. */
export type WorkerSample = Omit<SampleReport, 'machine'>;

export interface Measurement {
  /** Whether calls returned a promise and were awaited. */
  readonly async: boolean;
  readonly sample: WorkerSample;
  /**
   * `process.hrtime.bigint()` when measuring started: the same clock in
   * every thread, so the main thread can line its probes up with the ticks.
   */
  readonly start: bigint;
}

interface Limits {
  readonly runs: number;
  /** Nanoseconds. */
  readonly time: number;
}

/** How a measuring loop runs, see `loopSync`. */
interface LoopSettings {
  readonly batchSize: number;
  readonly limits: Limits;
  /** Nanoseconds between ticks. */
  readonly tickInterval: bigint;
  /** Nanoseconds between progress reports. */
  readonly progressInterval: bigint;
  readonly progress?: ((runs: number) => void) | undefined;
}

interface LoopResult {
  readonly start: bigint;
  readonly runs: number;
  readonly innerTime: number;
  readonly outerTime: number;
}

const earliest = (a: bigint, b: bigint, c: bigint): bigint => {
  const ab = a < b ? a : b;
  return ab < c ? ab : c;
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/**
 * Nanoseconds between progress reports for a `timeout` in milliseconds: a
 * quarter of it, so progress reaches the main thread well before it stops
 * the worker, from 1 ms to 250 ms.
 */
export const progressInterval = (timeout = Infinity): bigint => {
  const quarter = (timeout * 1e6) / 4;
  return quarter >= Number(PROGRESS_INTERVAL) ? PROGRESS_INTERVAL : (
      BigInt(Math.max(Number(MIN_PROGRESS_INTERVAL), Math.round(quarter)))
    );
};

/**
 * Mean of the values but outliers: values above Tukey's far-out fence, Q3 +
 * 3 × IQR, taking the IQR as at least the smallest step between values.
 * With a coarse timer, a share of the empty runs reads one step more than
 * the others: those are kept, interrupts are left out.
 */
export const meanWithoutOutliers = (values: Float64Array): number => {
  const sorted = values.slice().sort();
  const at = (share: number): number =>
    sorted[Math.floor((sorted.length - 1) * share)] ?? 0;
  let step = Infinity;
  for (let index = 1; index < sorted.length; index++) {
    const gap = (sorted[index] ?? 0) - (sorted[index - 1] ?? 0);
    if (gap > 0 && gap < step) step = gap;
  }
  const q3 = at(0.75);
  const fence =
    q3 + FENCE * Math.max(q3 - at(0.25), Number.isFinite(step) ? step : 0);
  let sum = 0;
  let kept = 0;
  for (const value of sorted) {
    if (value > fence) break;
    sum += value;
    kept++;
  }
  return kept > 0 ? sum / kept : 0;
};

const empty = (): unknown => undefined;

/**
 * Timer overhead of one run of `batchSize` calls, in nanoseconds: empty
 * runs timed exactly like real runs, once the JIT has optimized them. The
 * mean, not the median: with a coarse timer most empty runs read `0` and
 * some read one step, and only the mean tells the real cost between.
 * Warm-up and timed runs take at most 50 ms each, however big the batch.
 *
 * Kept apart from the measuring loops, so their call sites only ever see
 * the measured function.
 *
 * @param progress Called between runs, every `interval` nanoseconds.
 */
export const calibrate = (
  batchSize: number,
  progress?: () => void,
  interval = PROGRESS_INTERVAL
): number => {
  const times = new Float64Array(CALIBRATION_RUNS);
  const start = hrtime();
  let warming = true;
  let runs = 0;
  let timed = 0;
  let end = start + CALIBRATION_TIME;
  let nextProgress = start + interval;
  for (;;) {
    const before = hrtime();
    for (let call = 0; call < batchSize; call++) sink = empty();
    const after = hrtime();
    const time = Number(after - before);
    if (warming) {
      if (++runs >= CALIBRATION_WARMUP || after >= end) {
        warming = false;
        end = after + CALIBRATION_TIME;
      }
    } else {
      times[timed++] = time;
      if (timed >= CALIBRATION_RUNS || after >= end) break;
    }
    if (after >= nextProgress) {
      progress?.();
      nextProgress = after + interval;
    }
  }
  return meanWithoutOutliers(times.subarray(0, timed));
};

type Collect = () => void;

const noCollection: Collect = () => undefined;

/**
 * V8's `gc`, with `--expose-gc` turned on only while it is taken. V8 flags
 * belong to the process: a context another thread creates meanwhile gets a
 * `gc` too. Node warns that flags set at runtime may not take effect: then
 * measuring goes on without the collection.
 */
const exposeGc = (): Collect => {
  try {
    setFlagsFromString('--expose-gc');
    try {
      const gc: unknown = runInNewContext('gc');
      return typeof gc === 'function' ? (gc as Collect) : noCollection;
    } finally {
      // later contexts and workers don't get a `gc` global
      setFlagsFromString('--no-expose-gc');
    }
  } catch {
    return noCollection;
  }
};

let collect: Collect | undefined;

/**
 * Runs a full garbage collection: with the global `gc` when Node runs with
 * `--expose-gc`, otherwise with V8's `gc` taken from a new context while
 * the flag is briefly on (as Jest does), so no other code sees it. Does
 * nothing when V8 doesn't give its `gc`.
 */
export const collectGarbage = (): void => {
  collect ??= (globalThis as { gc?: Collect }).gc ?? exposeGc();
  collect();
};

/** Limits of a warm-up half, see `measure`. */
const halfOf = (span: Span): Limits =>
  'time' in span ?
    { runs: Infinity, time: (span.time * 1e6) / 2 }
  : { runs: Math.ceil(span.runs / 2), time: Infinity };

const isEmpty = (span: Span): boolean =>
  'time' in span ? span.time <= 0 : span.runs <= 0;

/** Runs and time of a sample's measuring loop. */
export const sampleLimits = (budget: SampleBudget, runTime: number): Limits => {
  if ('runs' in budget) return { runs: budget.runs, time: Infinity };
  if ('time' in budget) return { runs: Infinity, time: budget.time * 1e6 };
  const { min, max, runs } = budget.auto;
  return {
    runs: Infinity,
    time: Math.min(max * 1e6, Math.max(min * 1e6, runTime * runs)),
  };
};

type ThreadCpuUsage = (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;

/** Collects ticks: CPU and memory probes, as columns. */
class TickRecorder {
  readonly time: number[] = [];
  readonly runs: number[] = [];
  readonly innerTime: number[] = [];
  readonly cpu: number[] = [];
  readonly threadCpu: number[] = [];
  readonly rss: number[] = [];
  readonly heapUsed: number[] = [];
  private readonly threadCpuUsage: ThreadCpuUsage | undefined;
  private readonly cpuStart: NodeJS.CpuUsage;
  private readonly threadCpuStart: NodeJS.CpuUsage | undefined;

  constructor() {
    const { threadCpuUsage } = process as { threadCpuUsage?: ThreadCpuUsage };
    this.threadCpuUsage = threadCpuUsage?.bind(process);
    this.cpuStart = process.cpuUsage();
    this.threadCpuStart = this.threadCpuUsage?.();
  }

  take(time: number, runs: number, innerTime: number): void {
    const cpu = process.cpuUsage(this.cpuStart);
    const { rss, heapUsed } = process.memoryUsage();
    this.time.push(time);
    this.runs.push(runs);
    this.innerTime.push(innerTime);
    this.cpu.push(cpu.user + cpu.system);
    this.rss.push(rss);
    this.heapUsed.push(heapUsed);
    if (this.threadCpuUsage !== undefined) {
      const thread = this.threadCpuUsage(this.threadCpuStart);
      this.threadCpu.push(thread.user + thread.system);
    }
  }

  toJSON(): Ticks {
    const { time, runs, innerTime, cpu, threadCpu, rss, heapUsed } = this;
    return { time, runs, innerTime, cpu, threadCpu, rss, heapUsed };
  }
}

/*
 * The two measuring loops are the same but for `await`: a sync function
 * never pays for an async loop, and each loop's call site sees one function
 * only. A run is timed from the read before its calls to the read after
 * them; recording, ticks and limits happen between runs, outside the timed
 * part. Every sample makes at least one run. Between runs, one comparison
 * tells whether a tick, a progress report or the deadline is due.
 */

const loopSync = (
  fn: BenchFn,
  { batchSize, limits, tickInterval, progressInterval, progress }: LoopSettings,
  recorder: Recorder,
  ticks: TickRecorder
): LoopResult => {
  let runs = 0;
  let inner = 0;
  const start = hrtime();
  const deadline =
    start +
    (Number.isFinite(limits.time) ? BigInt(Math.ceil(limits.time)) : NEVER);
  let nextTick = start + tickInterval;
  let nextProgress = start + progressInterval;
  let check = earliest(nextTick, nextProgress, deadline);
  ticks.take(0, 0, 0);
  for (;;) {
    const before = hrtime();
    for (let call = 0; call < batchSize; call++) sink = fn();
    const after = hrtime();
    const time = Number(after - before);
    recorder.add(time);
    inner += time;
    if (++runs >= limits.runs) break;
    if (after >= check) {
      if (after >= deadline) break;
      if (after >= nextTick) {
        ticks.take(Number(after - start), runs, inner);
        nextTick = after + tickInterval;
      }
      if (after >= nextProgress) {
        progress?.(runs);
        nextProgress = after + progressInterval;
      }
      check = earliest(nextTick, nextProgress, deadline);
    }
  }
  const end = hrtime();
  ticks.take(Number(end - start), runs, inner);
  return { start, runs, innerTime: inner, outerTime: Number(end - start) };
};

const loopAsync = async (
  fn: BenchFn,
  { batchSize, limits, tickInterval, progressInterval, progress }: LoopSettings,
  recorder: Recorder,
  ticks: TickRecorder
): Promise<LoopResult> => {
  let runs = 0;
  let inner = 0;
  const start = hrtime();
  const deadline =
    start +
    (Number.isFinite(limits.time) ? BigInt(Math.ceil(limits.time)) : NEVER);
  let nextTick = start + tickInterval;
  let nextProgress = start + progressInterval;
  let check = earliest(nextTick, nextProgress, deadline);
  ticks.take(0, 0, 0);
  for (;;) {
    const before = hrtime();
    for (let call = 0; call < batchSize; call++) sink = await fn();
    const after = hrtime();
    const time = Number(after - before);
    recorder.add(time);
    inner += time;
    if (++runs >= limits.runs) break;
    if (after >= check) {
      if (after >= deadline) break;
      if (after >= nextTick) {
        ticks.take(Number(after - start), runs, inner);
        nextTick = after + tickInterval;
      }
      if (after >= nextProgress) {
        progress?.(runs);
        nextProgress = after + progressInterval;
      }
      check = earliest(nextTick, nextProgress, deadline);
    }
  }
  const end = hrtime();
  ticks.take(Number(end - start), runs, inner);
  return { start, runs, innerTime: inner, outerTime: Number(end - start) };
};

/**
 * Measures one sample of a function: calibrates the timer, calls the
 * function once to tell whether it's async, warms it up, collects the
 * garbage, then times runs until the sample's budget is spent, taking
 * ticks between runs.
 *
 * The warm-up runs the measuring loop itself, so the JIT has optimized the
 * loop as well as the function before measuring starts; its second half
 * estimates the time of a run, for `time: 'auto'`.
 *
 * Progress is reported all along, `0` runs until measuring starts, so a
 * long calibration or warm-up doesn't look stuck to the main thread.
 */
export const measure = async (
  fn: BenchFn,
  { budget, warmup, batchSize, tickInterval, timeout }: MeasureConfig,
  { progress }: MeasureHooks = {}
): Promise<Measurement> => {
  const every = progressInterval(timeout);
  const starting =
    progress === undefined ? undefined : (
      () => {
        progress(0);
      }
    );
  const overhead = calibrate(batchSize, starting, every) / batchSize;
  const settings = (
    limits: Limits,
    report: ((runs: number) => void) | undefined
  ): LoopSettings => ({
    batchSize,
    limits,
    tickInterval: BigInt(Math.max(1, Math.round(tickInterval * 1e6))),
    progressInterval: every,
    progress: report,
  });

  const firstStart = hrtime();
  const first = fn();
  const async = isThenable(first);
  sink = async ? await first : first;
  let runTime = Number(hrtime() - firstStart) * batchSize;
  const loop = async ? loopAsync : loopSync;
  if (!isEmpty(warmup)) {
    const half = settings(halfOf(warmup), starting);
    const warm = (): Promise<LoopResult> | LoopResult =>
      loop(fn, half, new Recorder(), new TickRecorder());
    await warm();
    const estimate = await warm();
    runTime = estimate.innerTime / estimate.runs;
  }
  progress?.(0);

  const limits = sampleLimits(budget, runTime);
  const recorder = new Recorder();
  // warm-up garbage isn't collected while measuring, and the first tick
  // holds the live heap only: the thread's cost
  collectGarbage();
  const ticks = new TickRecorder();
  const { start, runs, innerTime, outerTime } = await loop(
    fn,
    settings(limits, progress),
    recorder,
    ticks
  );
  return {
    async,
    start,
    sample: {
      runs,
      overhead,
      innerTime,
      outerTime,
      histogram: recorder.histogram(batchSize),
      ticks: ticks.toJSON(),
    },
  };
};
