/**
 * Async cases: a function returning a promise is awaited on every call.
 * Reading a file with a promise goes through libuv's thread pool: the
 * function's thread waits ("Function's thread CPU" below 100%) while a
 * pool thread reads ("All cores usage" counts every thread). Slow cases get
 * a longer `time: 'auto'`, up to 10 s, to collect enough runs.
 *
 * Run: node demo/async.js
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { bench, compare } from '@mmutils/bench';

const file = fileURLToPath(new URL('../package.json', import.meta.url));

await compare(
  bench('readFile (promise)', () => readFile(file, 'utf8')),
  bench('readFileSync', () => readFileSync(file, 'utf8')),
  bench('readFileSync, next turn', async () => {
    await nextTurn();
    return readFileSync(file, 'utf8');
  })
);
