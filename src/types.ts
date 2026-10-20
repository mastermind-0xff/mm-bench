/**
 * Public types of mm-bench.
 *
 * Terms used across the docs:
 * - **case**: a named function to measure, created by `bench`;
 * - **run**: one timed call of a case (or one batch of calls, see
 *   `batchSize`);
 * - **sample**: one fresh worker measuring one case. Samples of compared
 *   cases are interleaved (A B, B A, A B, …), so drift (CPU heat, background
 *   load) is shared by all cases;
 * - **tick**: one CPU and memory probe, taken between runs.
 *
 * All times are in nanoseconds unless a property says otherwise; options
 * take milliseconds.
 */

/**
 * A function to measure. Sync, or async: when the first call returns a
 * promise (any thenable), every call is awaited.
 *
 * Return the result of the work, e.g. `() => format(input)`: it is kept, so
 * V8 can't drop the work as dead code.
 *
 * The workers run your bench file again to get the function, so it can use
 * anything in scope: imports, data prepared at the top level, other
 * functions.
 */
export type BenchFn = () => unknown;

/** Length of a phase: a time in milliseconds, or a number of runs. */
export type Span = { readonly time: number } | { readonly runs: number };

/**
 * Time of a case chosen from its own speed: each sample estimates the time
 * of a run during its warm-up and measures long enough for its share of
 * `runs`, but at least its share of `min` and at most its share of `max`.
 * Fast cases get `min`, so they finish early with plenty of runs; slow cases
 * get up to `max`, to collect as many runs as they can.
 */
export interface AutoTime {
  /** Shortest measured time of the case in milliseconds. Default: `2000`. */
  readonly min?: number;
  /** Longest measured time of the case in milliseconds. Default: `10_000`. */
  readonly max?: number;
  /**
   * Runs of the case wanted for a smooth distribution. Default: `10_000`.
   */
  readonly runs?: number;
}

/**
 * How long a case is measured: for a `time`, or for an exact number of
 * `runs`. Set one of them; an options object with both is rejected.
 */
export type Budget =
  | {
      /**
       * Measured time of the case in milliseconds, split evenly between its
       * samples, or `'auto'` (see `AutoTime`) to choose it from the case's
       * speed. Warm-up, timer calibration and worker start-up come on top. A
       * run is never cut: a sample ends with the run that reaches its share,
       * and makes at least one run. Default: `'auto'`.
       */
      readonly time?: number | 'auto' | AutoTime;
      readonly runs?: never;
    }
  | {
      /**
       * Exact number of measured runs of the case, split evenly between its
       * samples (at least one each). Replaces `time`.
       */
      readonly runs?: number;
      readonly time?: never;
    };

export interface MeasureSettings {
  /**
   * Samples per case: each one is a fresh worker, with its own heap and JIT
   * state, so a case can't warm up or fill the heap for the next one.
   * Default: `4`.
   */
  readonly samples?: number;
  /**
   * Warm-up of each sample before its runs are measured, so the JIT has
   * optimized the case: `{ time }` in milliseconds or `{ runs }`. Its second
   * half estimates the time of a run, for `time: 'auto'`. At least one call,
   * which also tells whether the case is async. Default: `{ time: 100 }`.
   */
  readonly warmup?: Span;
  /**
   * Calls per run. With `1` every call is timed on its own: the true
   * distribution, but calls shorter than the timer's resolution (see
   * `Environment.timerResolution`, it depends on the hardware and the OS)
   * can't be told apart. A batch is timed as a whole and recorded as its
   * time per call, so the resolution per call is divided by the batch size,
   * at the cost of a smoother distribution. Default: `1`.
   */
  readonly batchSize?: number;
  /**
   * Subtract the timer's own cost from reported times. Each sample measures
   * it before its warm-up, by timing empty runs of `batchSize` calls the way
   * runs are timed (up to 5,000 runs or 50 ms), leaving out interrupts, and
   * reports it in `overhead`; histograms always keep the raw times, so this
   * only shifts the stats and the distribution. Default: `true`.
   */
  readonly subtractOverhead?: boolean;
  /**
   * Milliseconds between ticks (CPU and memory probes). Probes are taken
   * between runs, never inside one, so a run longer than the interval delays
   * the next tick. Ticks are cumulative counters, so they can be turned into
   * rates at any resolution; how often the OS updates CPU time differs (about
   * every 15.6 ms on Windows), so short windows can be coarse. Default:
   * `10`.
   */
  readonly tickInterval?: number;
  /**
   * Milliseconds a sample may go without progress before its worker is
   * stopped and the call rejects: catches endless loops and promises that
   * never settle. Workers report progress between runs (calibration and
   * warm-up included), four times per timeout at most every 250 ms, so a
   * single run may take up to about three quarters of it. Running the bench
   * file up to the call counts too: keep heavy setup within it. Default:
   * `60_000`.
   */
  readonly timeout?: number;
}

/** Options of a case, see `bench`. */
export type MeasureOptions = MeasureSettings & Budget;

/** Options a case was measured with, defaults filled in. */
export type ResolvedMeasureOptions = Required<MeasureSettings> &
  ({ readonly time: number | Required<AutoTime> } | { readonly runs: number });

export interface CallSettings {
  /**
   * File the workers import to get the cases: a path or a `file:` URL. The
   * workers run it until they reach this call (counted among the calls
   * passing the same file), so code before the call runs again in each
   * worker; calls before it resolve right away with an empty report there.
   * Default: the entry script (`process.argv[1]`). Pass `import.meta.url`
   * (or `__filename`) when the benchmark isn't started from the entry
   * script, e.g. from a test runner.
   */
  readonly file?: string | URL;
  /**
   * Directory `file` must be inside, after symlinks are resolved. Only
   * regular `.js` `.mjs` `.cjs` `.ts` `.mts` `.cts` files are imported.
   * Default: `process.cwd()`.
   */
  readonly root?: string;
  /**
   * Where the report goes: `true` for `loggerReporter()` (bar graphs side by
   * side, with @mmutils/logger), `false` for nothing (the returned report has all
   * the data), or a custom `Reporter`. Default: `true`.
   */
  readonly output?: boolean | Reporter;
}

/**
 * Options of `run` and `compare`. Measure options set defaults for all the
 * cases of the call; options given to `bench` win.
 */
export type RunOptions = MeasureOptions & CallSettings;

/** A case: a named function to measure, created by `bench`. */
export interface Bench {
  readonly name: string;
  readonly fn: BenchFn;
  readonly options: MeasureOptions;
  /**
   * Measures this case alone, see `compare`.
   *
   * ```ts
   * await bench('parse', () => parse(input)).run({ runs: 1_000_000 });
   * ```
   */
  run(options?: RunOptions): Promise<Report>;
}

/**
 * Creates a case. Nothing runs until the case is passed to `compare` or its
 * `run` is called.
 *
 * ```ts
 * const join = bench('join', () => words.join(' '));
 * const max = bench('max', () => Math.max(...values), { batchSize: 100 });
 * ```
 */
export type BenchFunction = (
  name: string,
  fn: BenchFn,
  options?: MeasureOptions
) => Bench;

/**
 * Measures cases side by side: samples are interleaved (A B, B A, …) and
 * the report shares its axes and ceilings between the cases, so their
 * graphs can be compared at a glance. Calls run one at a time, even when
 * they are started together.
 *
 * ```ts
 * await compare(join, reduce);
 * await compare(join, reduce, { time: 10_000, output: false });
 * ```
 */
export interface CompareFunction {
  (...cases: Bench[]): Promise<Report>;
  (...args: [...cases: Bench[], options: RunOptions]): Promise<Report>;
}

/** Machine the report was measured on. */
export interface Environment {
  /** `process.version`, e.g. `'v22.22.2'`. */
  readonly node: string;
  /** `process.versions.v8`. */
  readonly v8: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** CPU model, as the OS names it. */
  readonly cpu: string;
  /** Logical CPU cores. */
  readonly cores: number;
  /**
   * Smallest difference seen between two consecutive timer reads, in
   * nanoseconds: the timer's resolution, or the cost of a read when the
   * timer is finer. Measured when the first call starts; it depends on the
   * hardware and the OS. Durations closer than this can't be told apart, see
   * `batchSize`.
   */
  readonly timerResolution: number;
}

/** Result of a `compare` or `run` call: the raw data and its stats. */
export interface Report {
  /** Cases in the order they were passed. Empty in a worker, see `file`. */
  readonly cases: readonly CaseReport[];
  readonly environment: Environment;
  /** Wall time of the whole call in milliseconds. */
  readonly duration: number;
}

export interface CaseReport {
  readonly name: string;
  /** Whether calls returned a promise and were awaited. */
  readonly async: boolean;
  readonly options: ResolvedMeasureOptions;
  readonly stats: Stats;
  /**
   * Mean time per call relative to the fastest case of the report: `1` for
   * the fastest, `1.5` for 50% slower.
   */
  readonly relative: number;
  /**
   * Timer overhead per call (per run divided by `batchSize`), averaged over
   * the samples. Included in `histogram`, subtracted from `stats` when
   * `subtractOverhead` is on.
   */
  readonly overhead: number;
  /** Runs of all samples, merged. */
  readonly histogram: Histogram;
  /** Samples in the order they ran. */
  readonly samples: readonly SampleReport[];
}

/**
 * Times per call, overhead subtracted when `subtractOverhead` is on (never
 * below `0`).
 */
export interface Stats {
  /** Measured runs, all samples. */
  readonly runs: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly median: number;
  readonly p75: number;
  readonly p99: number;
  readonly p999: number;
  readonly stdDev: number;
  /** Calls per second at the mean time; `Infinity` for a mean of `0`. */
  readonly opsPerSecond: number;
}

/**
 * Exact distribution of the run times: `counts[i]` runs took `durations[i]`
 * per call. Lossless, apart from the order of the runs (see `Ticks` for
 * times over the sample), and samples merge by adding counts.
 */
export interface Histogram {
  /**
   * Distinct times per call in nanoseconds, ascending: run time divided by
   * `batchSize`, timer overhead included.
   */
  readonly durations: readonly number[];
  /** Runs per duration. */
  readonly counts: readonly number[];
}

/** One worker's measurement of a case. */
export interface SampleReport {
  /** Measured runs. */
  readonly runs: number;
  /** Timer overhead per call measured by this sample, see `CaseReport`. */
  readonly overhead: number;
  /** Sum of the timed runs, overhead included. */
  readonly innerTime: number;
  /**
   * Wall time of the measuring loop: the runs plus the loop's own work
   * (timer reads, recording, ticks). Compared to `innerTime`, it shows what
   * the measuring cost.
   */
  readonly outerTime: number;
  readonly histogram: Histogram;
  readonly ticks: Ticks;
  readonly machine: MachineTicks;
}

/**
 * CPU and memory probes of a sample, as columns: index `i` of every array
 * is the same tick. The first tick is taken when measuring starts and the
 * last when it ends. Counters are cumulative since measuring started, so
 * the rate between any two ticks is their difference, e.g. CPU % =
 * `Δcpu * 1000 / Δtime * 100`.
 */
export interface Ticks {
  /** Nanoseconds since measuring started. */
  readonly time: readonly number[];
  /** Runs finished. */
  readonly runs: readonly number[];
  /** Timed nanoseconds of the finished runs, overhead included. */
  readonly innerTime: readonly number[];
  /**
   * Process CPU time in microseconds, user and system, all threads: the
   * worker, V8's GC helpers and libuv's thread pool (async I/O, crypto).
   */
  readonly cpu: readonly number[];
  /**
   * CPU time of the worker's thread only, in microseconds. Empty on Node
   * versions without `process.threadCpuUsage`.
   */
  readonly threadCpu: readonly number[];
  /**
   * Resident set size in bytes. Process-wide: includes the main thread,
   * which is idle and steady while it waits.
   */
  readonly rss: readonly number[];
  /**
   * V8 heap used by the worker in bytes. The first tick is taken right
   * after a full garbage collection, so it is the live heap before the
   * measured runs: the thread's cost (V8's own, the modules, the bench
   * file's data, warm-up state). What comes on top is the case's.
   */
  readonly heapUsed: readonly number[];
}

/**
 * CPU times of every logical core of the machine during a sample, all
 * processes, as `os.cpus()` counts them: what else ran while the case was
 * measured, and how its work spread over the cores. The main thread probes
 * them about every 100 ms while the worker runs, so the measuring loop
 * never pays for a probe. The OS updates these times in steps (about 15.6
 * ms on Windows, 10 ms elsewhere), so only windows of 100 ms or more are
 * meaningful.
 *
 * Busy share of core `c` between probes `i` and `j`: `Δbusy[c] / (Δbusy[c]
 * + Δidle[c])`.
 */
export interface MachineTicks {
  /**
   * Nanoseconds since measuring started, as in `Ticks`: the first probe is
   * the last one before measuring started (`≤ 0`), the last probe the first
   * one after it ended, so the probes span the whole sample.
   */
  readonly time: readonly number[];
  /**
   * Busy milliseconds of each core since the first probe (user, nice,
   * system and interrupts): `busy[core][probe]`. Empty when the OS doesn't
   * report the cores.
   */
  readonly busy: readonly (readonly number[])[];
  /** Idle milliseconds of each core since the first probe. */
  readonly idle: readonly (readonly number[])[];
}

export interface DistributionOptions {
  /**
   * Number of buckets, usually the columns of the graph. Bucket widths are
   * whole multiples of the timer's resolution per call, so no bucket is
   * empty because of the timer; when cases have different batch sizes, the
   * finest resolution is used and the coarser cases show gaps between the
   * times their timer can tell apart. When that needs fewer buckets, the
   * range is padded with empty ones to `buckets / k` for a whole `k`, so
   * plotted in `buckets` columns each bucket is exactly `k` columns wide.
   * Default: `30`.
   */
  readonly buckets?: number;
  /**
   * Share of runs that keeps an end of the range: the fastest and slowest
   * `trim` of each case's runs are left out, then edge buckets holding less
   * than `trim` of every case's runs, so rare outliers (GC pauses, the OS
   * preempting the thread) don't squeeze all other runs into a few buckets.
   * They are still counted, in `below` and `above`. `0` keeps every run.
   * Default: `0.001` (0.1%).
   */
  readonly trim?: number;
}

/**
 * Run times of a report's cases in equal buckets over a shared range,
 * ready to plot: time on the X axis, percent of runs on the Y axis.
 *
 * ```ts
 * const { start, end, cases } = distribution(report, { buckets: 40 });
 * for (const { name, percents } of cases)
 *   logger.infoGraph(percents, { title: name, axis: { start, end, unit: 'ns' } });
 * ```
 */
export interface Distribution {
  /** Start of the first bucket. */
  readonly start: number;
  /** End of the last bucket. */
  readonly end: number;
  /** Width of every bucket. */
  readonly width: number;
  readonly cases: readonly CaseDistribution[];
}

export interface CaseDistribution {
  readonly name: string;
  /** Runs per bucket, in percent of all the case's runs. */
  readonly percents: readonly number[];
  /** Runs per bucket. */
  readonly counts: readonly number[];
  /** Runs faster than the range, left out by `trim`. */
  readonly below: number;
  /** Runs slower than the range, left out by `trim`. */
  readonly above: number;
}

export type DistributionFunction = (
  report: Report,
  options?: DistributionOptions
) => Distribution;

/**
 * Receives progress and the report of `run` and `compare` calls. Returned
 * promises are awaited, so a reporter can't overlap the measuring.
 */
export interface Reporter {
  /** Called before the first sample. */
  start?(plan: Plan): void | Promise<void>;
  /** Called after each sample, e.g. to show progress. */
  sample?(progress: SampleProgress): void | Promise<void>;
  /** Called with the finished report, before the call resolves. */
  end?(report: Report): void | Promise<void>;
}

/** What a call is about to measure. */
export interface Plan {
  readonly cases: readonly {
    readonly name: string;
    readonly options: ResolvedMeasureOptions;
  }[];
  readonly environment: Environment;
}

export interface SampleProgress {
  /** Name of the measured case. */
  readonly case: string;
  /** Number of this sample, from `1`. */
  readonly sample: number;
  /** Samples of the case. */
  readonly samples: number;
  /** Whether the case's calls are awaited. */
  readonly async: boolean;
  readonly result: SampleReport;
}

/**
 * Graphs `loggerReporter` can draw for each case. All but the distribution
 * are over the sample, with their average, min and max; the compared cases
 * share every scale, so the case that stands out shows:
 * - `'distribution'`: percent of runs per run time;
 * - `'timeline'`: mean run time (JIT tier-ups, GC pauses, drift);
 * - `'thread'`: CPU usage of the function's thread (the worker calling
 *   it), 0–100% of one core: below 100% while the function waits (I/O,
 *   timers, other threads);
 * - `'cores'`: CPU usage of the process, all threads, in percent of all
 *   the machine's cores: the function's, V8's GC and compiler threads,
 *   libuv's thread pool (async I/O, crypto, zlib) and the main thread.
 *   Scaled to the highest of the compared cases;
 * - `'heapDelta'`: the worker's V8 heap above its thread cost (see
 *   `Ticks.heapUsed`): the case's own memory, garbage and retained;
 * - `'heap'`: the worker's total V8 heap, thread cost included;
 * - `'machine'`: busy share of every logical core of the machine, all
 *   processes (see `MachineTicks`): what else ran, and how the work spread
 *   over the cores. Not drawn by default.
 */
export type GraphName =
  | 'distribution'
  | 'timeline'
  | 'thread'
  | 'cores'
  | 'heapDelta'
  | 'heap'
  | 'machine';

/**
 * Fields of `loggerReporter`'s summary table, one column each, named after
 * the report's data:
 * - `'mean'`, `'median'`, `'p75'`, `'p99'`, `'p999'`, `'min'`, `'max'`,
 *   `'stdDev'`: times per call from `Stats`;
 * - `'opsPerSecond'`: calls per second at the mean time;
 * - `'runs'`: measured runs, all samples;
 * - `'relative'`: `fastest`, or how much slower than the fastest case, from
 *   `CaseReport.relative`.
 */
export type SummaryField =
  | 'mean'
  | 'median'
  | 'p75'
  | 'p99'
  | 'p999'
  | 'min'
  | 'max'
  | 'stdDev'
  | 'opsPerSecond'
  | 'runs'
  | 'relative';

export interface LoggerReporterOptions {
  /**
   * Width of each case's column in terminal columns, frame excluded.
   * Default: the terminal width (80 when unknown) split between `columns`.
   */
  readonly width?: number;
  /**
   * Most cases side by side; more continue below, in the same columns.
   * Default: as many as fit at a width of at least 40.
   */
  readonly columns?: number;
  /**
   * Graphs of each case, top to bottom. Default: `DEFAULT_GRAPHS`, all but
   * `'machine'`; add it with `[...DEFAULT_GRAPHS, 'machine']`.
   */
  readonly graphs?: readonly GraphName[];
  /**
   * Table of the cases after their graphs, a row per case in call order and
   * a column per field, when there are two or more cases: `true` for
   * `DEFAULT_SUMMARY`, `false` (or `[]`) for none, or the fields in their
   * order, e.g. `[...DEFAULT_SUMMARY, 'runs']`. Names are shortened to fit
   * the terminal; pick fewer fields for a narrow one. Default: `true`.
   */
  readonly summary?: boolean | readonly SummaryField[];
  /**
   * Buckets of the distribution graph: `'cols'` for one per graph column
   * (sharpest), or a number, which the graph scales to its columns.
   * Default: `'cols'`.
   */
  readonly buckets?: number | 'cols';
  /** See `DistributionOptions.trim`. Default: `0.001`. */
  readonly trim?: number;
  /** Rows of the distribution graph; the others take a third. Default: `9`. */
  readonly rows?: number;
  /** Print a line per finished sample. Default: `true`. */
  readonly progress?: boolean;
  /** Paint with colors. Default: `true`, unless `NO_COLOR` is set. */
  readonly colors?: boolean;
  /** Line destination. Default: `console.log`. */
  readonly write?: (text: string) => void;
}

export type LoggerReporterFunction = (
  options?: LoggerReporterOptions
) => Reporter;
