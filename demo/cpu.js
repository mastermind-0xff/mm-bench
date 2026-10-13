/**
 * CPU: the same hashing on the function's thread, on one thread of libuv's
 * pool, and on four pool threads at once (four hashes per call).
 *
 * - "Function's thread" (0–100% of a core): the thread calling the
 *   function. The sync case keeps it busy; the pool cases leave it
 *   waiting.
 * - "All cores usage", in percent of the machine, all threads, scaled to
 *   the highest of the cases: one core's share for the first two (8% of 12
 *   cores), about four cores' for the last (33%).
 * - "Machine cores" (added to the default graphs here): every logical core
 *   of the machine, all processes: how the work spread over the cores, and
 *   what else ran meanwhile.
 *
 * Run: node demo/cpu.js
 */
import { pbkdf2, pbkdf2Sync } from 'node:crypto';
import { promisify } from 'node:util';
import { bench, compare, DEFAULT_GRAPHS, loggerReporter } from 'mm-bench';

const hash = promisify(pbkdf2);
const args = /** @type {const} */ (['password', 'salt', 2500, 32, 'sha256']);

await compare(
  bench('sync', () => pbkdf2Sync(...args)),
  bench('pool, 1 at a time', () => hash(...args)),
  bench('pool, 4 at once', () =>
    Promise.all([hash(...args), hash(...args), hash(...args), hash(...args)])
  ),
  { output: loggerReporter({ graphs: [...DEFAULT_GRAPHS, 'machine'] }) }
);
