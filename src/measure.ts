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
/** Share of the slowest empty runs (interrupts) left out of the overhead. */
const CALIBRATION_TRIM = 0.05;
/** Nanoseconds between progress reports. */
const PROGRESS_INTERVAL = 250_000_000n;
/** A deadline no sample reaches: about 146 years. */
const NEVER = 1n << 62n;

/**
 * Results of the measured calls, kept so V8 can't drop the calls as dead
 * code.
 */
export let sink: unknown;

export interface MeasureConfig {
  /** This sample's budget, see `sampleBudget`. */
  readonly budget: SampleBudget;
  readonly warmup: Span;
  readonly batchSize: number;
  /** Milliseconds between ticks. */
  readonly tickInterval: number;
}

export interface MeasureHooks {
  /** Called with the runs so far, at most every 250 ms while measuring. */
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

interface LoopResult {
  readonly start: bigint;
  readonly runs: number;
  readonly innerTime: number;
  readonly outerTime: number;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

/**
 * Mean of the values, leaving out the `trim` share of the highest ones.
 */
export const trimmedMean = (values: Float64Array, trim: number): number => {
  const sorted = values.slice().sort();
  const kept = Math.max(1, Math.floor(sorted.length * (1 - trim)));
  let sum = 0;
  for (let index = 0; index < kept; index++) sum += sorted[index] ?? 0;
  return sum / kept;
};

const empty = (): unknown => undefined;

/**
 * Timer overhead of one run of `batchSize` calls, in nanoseconds: empty
 * runs timed exactly like real runs, once the JIT has optimized them. The
 * mean, not the median: with a coarse timer most empty runs read `0` and
 * some read one step, and only the mean tells the real cost between.
 *
 * Kept apart from the measuring loops, so their call sites only ever see
 * the measured function.
 */
export const calibrate = (batchSize: number): number => {
  const times = new Float64Array(CALIBRATION_RUNS);
  for (let index = 0; index < CALIBRATION_WARMUP + CALIBRATION_RUNS; index++) {
    const start = hrtime();
    for (let call = 0; call < batchSize; call++) sink = empty();
    const time = Number(hrtime() - start);
    if (index >= CALIBRATION_WARMUP) times[index - CALIBRATION_WARMUP] = time;
  }
  return trimmedMean(times, CALIBRATION_TRIM);
};

type Collect = () => void;

/** V8's `gc`, with `--expose-gc` turned on only while it is taken. */
const exposeGc = (): Collect => {
  setFlagsFromString('--expose-gc');
  try {
    const gc: unknown = runInNewContext('gc');
    return typeof gc === 'function' ? (gc as Collect) : () => undefined;
  } finally {
    // later contexts and workers don't get a `gc` global
    setFlagsFromString('--no-expose-gc');
  }
};

let collect: Collect | undefined;

/**
 * Runs a full garbage collection: with the global `gc` when Node runs with
 * `--expose-gc`, otherwise with V8's `gc` taken from a new context while
 * the flag is briefly on (as Jest does), so no other code sees it.
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
 * part. Every sample makes at least one run.
 */

const loopSync = (
  fn: BenchFn,
  batchSize: number,
  limits: Limits,
  tickInterval: bigint,
  recorder: Recorder,
  ticks: TickRecorder,
  progress?: (runs: number) => void
): LoopResult => {
  let runs = 0;
  let inner = 0;
  const start = hrtime();
  const deadline =
    start +
    (Number.isFinite(limits.time) ? BigInt(Math.ceil(limits.time)) : NEVER);
  let nextTick = start + tickInterval;
  let check = nextTick < deadline ? nextTick : deadline;
  let nextProgress = start + PROGRESS_INTERVAL;
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
      ticks.take(Number(after - start), runs, inner);
      if (after >= nextProgress) {
        progress?.(runs);
        nextProgress = after + PROGRESS_INTERVAL;
      }
      nextTick = after + tickInterval;
      check = nextTick < deadline ? nextTick : deadline;
    }
  }
  const end = hrtime();
  ticks.take(Number(end - start), runs, inner);
  return { start, runs, innerTime: inner, outerTime: Number(end - start) };
};

const loopAsync = async (
  fn: BenchFn,
  batchSize: number,
  limits: Limits,
  tickInterval: bigint,
  recorder: Recorder,
  ticks: TickRecorder,
  progress?: (runs: number) => void
): Promise<LoopResult> => {
  let runs = 0;
  let inner = 0;
  const start = hrtime();
  const deadline =
    start +
    (Number.isFinite(limits.time) ? BigInt(Math.ceil(limits.time)) : NEVER);
  let nextTick = start + tickInterval;
  let check = nextTick < deadline ? nextTick : deadline;
  let nextProgress = start + PROGRESS_INTERVAL;
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
      ticks.take(Number(after - start), runs, inner);
      if (after >= nextProgress) {
        progress?.(runs);
        nextProgress = after + PROGRESS_INTERVAL;
      }
      nextTick = after + tickInterval;
      check = nextTick < deadline ? nextTick : deadline;
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
 */
export const measure = async (
  fn: BenchFn,
  { budget, warmup, batchSize, tickInterval }: MeasureConfig,
  { progress }: MeasureHooks = {}
): Promise<Measurement> => {
  const overhead = calibrate(batchSize) / batchSize;
  const interval = BigInt(Math.max(1, Math.round(tickInterval * 1e6)));

  const firstStart = hrtime();
  const first = fn();
  const async = isThenable(first);
  sink = async ? await first : first;
  let runTime = Number(hrtime() - firstStart) * batchSize;
  const loop = async ? loopAsync : loopSync;
  if (!isEmpty(warmup)) {
    const half = halfOf(warmup);
    const warm = (): Promise<LoopResult> | LoopResult =>
      loop(fn, batchSize, half, interval, new Recorder(), new TickRecorder());
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
    batchSize,
    limits,
    interval,
    recorder,
    ticks,
    progress
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
