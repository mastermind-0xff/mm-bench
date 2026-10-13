import { cpus } from 'node:os';
import type { MachineTicks } from './types.js';

/** Milliseconds between probes of the machine's cores. */
export const MACHINE_INTERVAL = 100;

/** CPU times of every logical core at one moment, in milliseconds. */
interface Probe {
  /** `process.hrtime.bigint()`: the same clock in every thread. */
  readonly time: bigint;
  readonly busy: readonly number[];
  readonly idle: readonly number[];
}

/** Windows counts interrupt time in `sys` too, other platforms apart. */
const COUNT_IRQ = process.platform !== 'win32';

const probe = (): Probe => {
  const time = process.hrtime.bigint();
  const busy: number[] = [];
  const idle: number[] = [];
  for (const { times } of cpus()) {
    busy.push(
      times.user + times.nice + times.sys + (COUNT_IRQ ? times.irq : 0)
    );
    idle.push(times.idle);
  }
  return { time, busy, idle };
};

/**
 * Probes the CPU times of the machine's cores, all processes, every
 * `interval` milliseconds until stopped: one probe right away, then on a
 * timer. Runs on the main thread while a worker measures: `os.cpus()`
 * takes about a millisecond on Windows and allocates, too much for the
 * measuring loop.
 */
export class MachineProbe {
  private readonly probes: Probe[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(interval = MACHINE_INTERVAL) {
    this.take();
    this.timer = setInterval(() => {
      this.take();
    }, interval);
    // the worker keeps the process alive, the probes never do
    this.timer.unref();
  }

  /** Takes a probe now, e.g. once measuring ended. */
  take(): void {
    this.probes.push(probe());
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * The probes around measuring from `start` to `end` (`hrtime` values),
   * relative to `start` and to the first kept probe: from the last probe at
   * or before `start` to the first at or after `end`, or the nearest ones
   * when the probes don't reach that far.
   */
  ticks(start: bigint, end: bigint): MachineTicks {
    const { probes } = this;
    let first = 0;
    while (
      first + 1 < probes.length &&
      (probes[first + 1]?.time ?? end) <= start
    )
      first++;
    let last = probes.length - 1;
    while (last - 1 > first && (probes[last - 1]?.time ?? start) >= end) last--;
    const kept = probes.slice(first, last + 1);
    const [base] = kept;
    if (base === undefined) return { time: [], busy: [], idle: [] };
    const cores = Math.min(...kept.map(({ busy }) => busy.length));
    const column = (key: 'busy' | 'idle', core: number): number[] =>
      kept.map((each) => (each[key][core] ?? 0) - (base[key][core] ?? 0));
    return {
      time: kept.map(({ time }) => Number(time - start)),
      busy: Array.from({ length: cores }, (_, core) => column('busy', core)),
      idle: Array.from({ length: cores }, (_, core) => column('idle', core)),
    };
  }
}
