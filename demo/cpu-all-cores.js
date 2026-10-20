/**
 * All cores: the same work, one hash per logical core on every call, done
 * on the function's thread or split over a helper worker per core.
 *
 * - "Function's thread": busy for the first case, waiting for the
 *   helpers in the second.
 * - "All cores usage", in percent of the machine: one core's share for the
 *   first case, close to 100% for the second, minus what other processes
 *   take.
 * - "Machine cores" (added to the default graphs here): one core at a time
 *   (the thread moves between cores) against every core busy.
 *
 * Other processes compete for the cores the second case needs, so a busy
 * machine slows it down and makes it noisy: watch for the busy machine
 * warning.
 *
 * Run: node demo/cpu-all-cores.js
 */
import { pbkdf2Sync } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { bench, compare, DEFAULT_GRAPHS, loggerReporter } from '@mmutils/bench';

const cores = availableParallelism();
/** About a quarter of a millisecond per hash. */
const ITERATIONS = 640;
const hash = () => pbkdf2Sync('password', 'salt', ITERATIONS, 32, 'sha256');

// a helper hashes on request; the code is a constant, nothing is imported
const HELPER = `
const { parentPort } = require('node:worker_threads');
const { pbkdf2Sync } = require('node:crypto');
parentPort.on('message', (iterations) => {
  parentPort.postMessage(
    pbkdf2Sync('password', 'salt', iterations, 32, 'sha256').length
  );
});`;

/** One helper per core, started by the first call: in measuring workers only. */
let helpers;
const ask = (helper) =>
  new Promise((resolve) => {
    helper.once('message', resolve);
    helper.postMessage(ITERATIONS);
  });

await compare(
  bench('one thread', () => {
    let length = 0;
    for (let index = 0; index < cores; index++) length += hash().length;
    return length;
  }),
  bench(`${cores} helper threads`, () => {
    helpers ??= Array.from(
      { length: cores },
      () => new Worker(HELPER, { eval: true })
    );
    return Promise.all(helpers.map(ask));
  }),
  { output: loggerReporter({ graphs: [...DEFAULT_GRAPHS, 'machine'] }) }
);
