import type { MachineTicks, SampleReport, Ticks } from './types.js';

/**
 * Values of a cumulative counter at the edges of `columns` equal windows
 * from `0` to `span`, linear between ticks (and past the first and last
 * ones).
 */
const valuesAtEdges = (
  time: readonly number[],
  values: readonly number[],
  columns: number,
  span: number
): number[] => {
  const edges: number[] = [];
  let index = 0;
  for (let column = 0; column <= columns; column++) {
    const edge = (span * column) / columns;
    while (index < time.length - 2 && (time[index + 1] ?? 0) < edge) index++;
    const t0 = time[index] ?? 0;
    const t1 = time[index + 1] ?? t0;
    const v0 = values[index] ?? 0;
    const v1 = values[index + 1] ?? v0;
    edges.push(t1 > t0 ? v0 + ((v1 - v0) * (edge - t0)) / (t1 - t0) : v1);
  }
  return edges;
};

/** Differences between consecutive edges. */
const deltas = (edges: readonly number[]): number[] =>
  edges.slice(1).map((value, index) => value - (edges[index] ?? 0));

/**
 * Rate of a cumulative counter in each of `columns` equal windows from `0`
 * to `span` (default: the last tick): Δvalue per nanosecond. `NaN` for
 * every window when the span is empty.
 */
export const rates = (
  time: readonly number[],
  values: readonly number[],
  columns: number,
  span = time.at(-1) ?? 0
): number[] => {
  if (!(span > 0) || time.length < 2)
    return new Array<number>(columns).fill(NaN);
  return deltas(valuesAtEdges(time, values, columns, span)).map(
    (delta) => delta / (span / columns)
  );
};

/**
 * Highest value of a level (e.g. memory) in each of `columns` equal windows
 * of the ticks' span; windows without a tick take the value at their
 * middle, linear between ticks.
 */
export const levels = (
  time: readonly number[],
  values: readonly number[],
  columns: number
): number[] => {
  const span = time.at(-1) ?? 0;
  if (!(span > 0) || time.length < 2)
    return new Array<number>(columns).fill(NaN);
  const highest = new Array<number>(columns).fill(-Infinity);
  time.forEach((t, index) => {
    const column = Math.min(columns - 1, Math.floor((t / span) * columns));
    highest[column] = Math.max(
      highest[column] ?? -Infinity,
      values[index] ?? NaN
    );
  });
  const atMiddles = valuesAtEdges(time, values, columns * 2, span).filter(
    (_, index) => index % 2 === 1
  );
  return highest.map((value, column) =>
    value === -Infinity ? (atMiddles[column] ?? NaN) : value
  );
};

/**
 * Ratio of two counters' deltas per window, e.g. timed nanoseconds per run,
 * over windows as in `rates`. `NaN` where the second counter didn't change.
 */
export const ratios = (
  time: readonly number[],
  numerator: readonly number[],
  denominator: readonly number[],
  columns: number,
  span = time.at(-1) ?? 0
): number[] => {
  if (!(span > 0) || time.length < 2)
    return new Array<number>(columns).fill(NaN);
  const top = deltas(valuesAtEdges(time, numerator, columns, span));
  const bottom = deltas(valuesAtEdges(time, denominator, columns, span));
  return top.map((value, index) => {
    const divisor = bottom[index] ?? 0;
    return divisor > 0 ? value / divisor : NaN;
  });
};

/**
 * Averages series of the same length value by value, skipping `NaN`s;
 * `NaN` where every series is `NaN`.
 */
export const averageSeries = (
  series: readonly (readonly number[])[]
): number[] => {
  const length = Math.max(0, ...series.map((values) => values.length));
  return Array.from({ length }, (_, index) => {
    let sum = 0;
    let count = 0;
    for (const values of series) {
      const value = values[index];
      if (value === undefined || Number.isNaN(value)) continue;
      sum += value;
      count++;
    }
    return count > 0 ? sum / count : NaN;
  });
};

/** Replaces each `NaN` with the value before it (the first one after it). */
export const fillGaps = (values: readonly number[]): number[] => {
  const first = values.find((value) => !Number.isNaN(value)) ?? 0;
  let last = first;
  return values.map((value) => {
    if (Number.isNaN(value)) return last;
    last = value;
    return value;
  });
};

/** A case's samples over their measuring time, averaged sample by sample. */
export interface CaseSeries {
  /** Mean measuring time of the samples: the span of every series. */
  readonly duration: number;
  /** Mean time per call in nanoseconds, overhead subtracted. */
  readonly timeline: readonly number[];
  /**
   * CPU usage of the function's thread (the worker), in percent of one
   * core. Empty on Node versions without `process.threadCpuUsage`.
   */
  readonly thread: readonly number[];
  /** CPU usage of the process in cores, all threads. */
  readonly cores: readonly number[];
  /** Highest V8 heap used by the worker in bytes. */
  readonly heapUsed: readonly number[];
  /**
   * Mean thread cost of the samples in bytes: the heap when measuring
   * started, right after a full garbage collection.
   */
  readonly heapBase: number;
  /** Highest V8 heap used by the worker above its thread cost, in bytes. */
  readonly heapDelta: readonly number[];
  /**
   * Busy share of each logical core of the machine in percent, all
   * processes: `machine[core][column]`. Empty when the OS doesn't report
   * the cores.
   */
  readonly machine: readonly (readonly number[])[];
}

export interface CaseSeriesOptions {
  /** Calls per run, to get times per call. Default: `1`. */
  readonly batchSize?: number;
  /**
   * Subtracted from times per call (the timer overhead), never below 0.
   * Default: `0`.
   */
  readonly shift?: number;
  /**
   * Shortest window CPU usage is measured over, in nanoseconds: a few steps
   * of the OS's CPU clock (see `cpuWindowOf`), or windows read 0% or
   * several hundred. Wider windows span several columns. Default: `0`.
   */
  readonly cpuWindow?: number;
  /**
   * Shortest window of the machine's core usage in nanoseconds, as
   * `cpuWindow`: the probes are about 100 ms apart, and the OS counts core
   * times in steps of 10 ms to 15.6 ms. Default: `MACHINE_WINDOW`.
   */
  readonly machineWindow?: number;
}

/**
 * Shortest meaningful CPU usage window on a platform, in nanoseconds:
 * Windows updates CPU times every 15.6 ms, so four of its steps; other
 * platforms count CPU time precisely.
 */
export const cpuWindowOf = (platform: NodeJS.Platform): number =>
  platform === 'win32' ? 62.5e6 : 0;

/** Default `machineWindow`: 125 ms, eight steps of Windows' CPU clock. */
export const MACHINE_WINDOW = 125e6;

/** Repeats `values` over `columns`, each over an equal share. */
export const stretch = (values: readonly number[], columns: number): number[] =>
  Array.from(
    { length: columns },
    (_, column) => values[Math.floor((column * values.length) / columns)] ?? NaN
  );

/**
 * Caps values at `cap`, carrying the excess into the next value: a counter
 * that steps coarsely (CPU time on Windows) can put a window above what is
 * possible, by time that belongs to the next one. Keeps the sum, but for
 * an excess at the very end. `NaN`s pass through.
 */
export const capWithCarry = (
  values: readonly number[],
  cap: number
): number[] => {
  let carry = 0;
  return values.map((value) => {
    if (Number.isNaN(value)) return value;
    const total = value + carry;
    carry = Math.max(0, total - cap);
    return Math.min(total, cap);
  });
};

/** Windows of at least `window` ns in `duration`, from 1 to `columns`. */
const windowsOf = (
  duration: number,
  window: number,
  columns: number
): number =>
  window > 0 ?
    Math.max(1, Math.min(columns, Math.floor(duration / window)))
  : columns;

/**
 * A CPU time counter in µs as cores busy, per window, at most `cap` (see
 * `capWithCarry`).
 */
const coresOf = (
  ticks: Ticks,
  values: readonly number[],
  windows: number,
  columns: number,
  cap = Infinity
): number[] =>
  stretch(
    capWithCarry(
      // µs of CPU per ns of wall time
      rates(ticks.time, values, windows).map((rate) => rate * 1e3),
      cap
    ),
    columns
  );

/** Busy share of each core in percent, per window from `0` to `span`. */
const machineOf = (
  { time, busy, idle }: MachineTicks,
  span: number,
  windows: number,
  columns: number
): number[][] =>
  busy.map((busyTimes, core) => {
    const idleTimes = idle[core] ?? [];
    const totals = busyTimes.map(
      (value, index) => value + (idleTimes[index] ?? 0)
    );
    return stretch(
      ratios(time, busyTimes, totals, windows, span).map(
        (share) => share * 100
      ),
      columns
    );
  });

/**
 * Resamples a case's ticks to `columns` windows of each sample's measuring
 * time and averages the samples.
 */
export const caseSeries = (
  samples: readonly SampleReport[],
  columns: number,
  {
    batchSize = 1,
    shift = 0,
    cpuWindow = 0,
    machineWindow = MACHINE_WINDOW,
  }: CaseSeriesOptions = {}
): CaseSeries => {
  const duration =
    samples.reduce((sum, { ticks }) => sum + (ticks.time.at(-1) ?? 0), 0) /
    Math.max(1, samples.length);
  const cpuWindows = windowsOf(duration, cpuWindow, columns);
  const machineWindows = windowsOf(duration, machineWindow, columns);
  const each = samples.map(({ ticks, machine }) => ({
    timeline: ratios(ticks.time, ticks.innerTime, ticks.runs, columns).map(
      (perRun) => Math.max(0, perRun / batchSize - shift)
    ),
    thread:
      ticks.threadCpu.length === ticks.time.length ?
        // a thread can't use more than one core
        coresOf(ticks, ticks.threadCpu, cpuWindows, columns, 1).map(
          (cores) => cores * 100
        )
      : undefined,
    cores: coresOf(ticks, ticks.cpu, cpuWindows, columns),
    heapUsed: levels(ticks.time, ticks.heapUsed, columns),
    heapDelta: levels(
      ticks.time,
      ticks.heapUsed.map((bytes) => bytes - (ticks.heapUsed[0] ?? 0)),
      columns
    ),
    machine: machineOf(
      machine,
      ticks.time.at(-1) ?? 0,
      machineWindows,
      columns
    ),
  }));
  const average = (series: readonly (readonly number[])[]): number[] =>
    fillGaps(averageSeries(series));
  const threads = each.flatMap(({ thread }) => (thread ? [thread] : []));
  const machineCores = Math.max(
    0,
    ...each.map(({ machine }) => machine.length)
  );
  return {
    duration,
    timeline: average(each.map((sample) => sample.timeline)),
    thread: threads.length > 0 ? average(threads) : [],
    cores: average(each.map((sample) => sample.cores)),
    heapUsed: average(each.map((sample) => sample.heapUsed)),
    heapBase:
      samples.reduce((sum, { ticks }) => sum + (ticks.heapUsed[0] ?? 0), 0) /
      Math.max(1, samples.length),
    heapDelta: average(each.map((sample) => sample.heapDelta)),
    machine: Array.from({ length: machineCores }, (_, core) =>
      average(each.flatMap(({ machine }) => machine.slice(core, core + 1)))
    ),
  };
};
