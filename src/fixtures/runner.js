// Measured by runner.spec.ts through runSample: only the workers run this
// file, one case each, never the main thread. The cases check what they
// see in the worker, and fail the ways a worker can.
import { bench, compare, isWorker } from '@mmutils/bench';

const options = { file: import.meta.url, output: false };

// an earlier call: in a worker it resolves right away, with an empty report
const earlier = await compare(
  bench('earlier', () => 0),
  options
);

/** Keeps the thread busy for `ms` milliseconds. */
const busy = (ms) => {
  const end = performance.now() + ms;
  let spins = 0;
  while (performance.now() < end) spins++;
  return spins;
};

await compare(
  bench('in a worker', () => {
    if (!isWorker()) throw new Error('not in a worker');
    if (earlier.environment.cpu !== 'main thread CPU')
      throw new Error(
        `earlier calls got another environment: ${earlier.environment.cpu}`
      );
    return earlier.cases.length;
  }),
  bench('exits', () => process.exit(3)),
  bench('throws later', async () => {
    setTimeout(() => {
      throw new Error('thrown later');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }),
  bench('stuck', () => {
    console.error('stuck here');
    // the interval keeps the worker alive: only the timeout stops it
    return new Promise(() => setInterval(() => {}, 1000));
  }),
  bench('slow warm-up', () => busy(50)),
  options
);
