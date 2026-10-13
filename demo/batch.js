/**
 * Very fast functions and the timer. A call to `Math.max` takes a few
 * nanoseconds, less than one step of the timer on many machines (see
 * "timer step" in the header): timed one call at a time, most runs read
 * `0` or one step, and only the mean is meaningful. Timed in batches, the
 * timer step per call is divided by the batch size.
 *
 * Run: node demo/batch.js
 */
import { bench, compare } from 'mm-bench';

const values = [3, 1, 4, 1, 5, 9, 2, 6];

await compare(
  bench('one call per run', () => Math.max(...values)),
  bench('100 calls per run', () => Math.max(...values), { batchSize: 100 }),
  { time: 2000 }
);
