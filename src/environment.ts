import { availableParallelism, cpus } from 'node:os';
import type { Environment } from './types.js';

const hrtime = (): bigint => process.hrtime.bigint();

/**
 * Smallest positive difference between two consecutive timer reads, in
 * nanoseconds: the timer's resolution, or the cost of a read when the timer
 * is finer.
 *
 * @param reads Pairs of reads to try.
 */
export const measureTimerResolution = (reads = 50_000): number => {
  let smallest = Infinity;
  for (let index = 0; index < reads; index++) {
    const start = hrtime();
    const difference = Number(hrtime() - start);
    if (difference > 0 && difference < smallest) smallest = difference;
  }
  return Number.isFinite(smallest) ? smallest : 1;
};

let cached: Environment | undefined;

/** The machine's description, measured once per thread. */
export const environment = (): Environment =>
  (cached ??= {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    cores: availableParallelism(),
    timerResolution: measureTimerResolution(),
  });
