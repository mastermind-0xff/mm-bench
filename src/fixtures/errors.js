// Calls that fail, their error messages as JSON.
import { bench, compare } from 'mm-bench';

const options = { runs: 10, samples: 1, warmup: { runs: 1 }, output: false };
const messages = [];
const attempt = async (call) => {
  try {
    await call();
    messages.push('resolved');
  } catch (error) {
    messages.push(error.message);
  }
};

await attempt(() =>
  bench('throws', () => {
    throw new Error('boom');
  }).run(options)
);
await attempt(() =>
  bench('never settles', () => new Promise(() => {})).run(options)
);
await attempt(() =>
  bench(
    'stuck',
    // the interval keeps the worker alive: only the timeout stops it
    () => new Promise(() => setInterval(() => {}, 1000)),
    { timeout: 300 }
  ).run(options)
);
await attempt(() =>
  bench('elsewhere', () => 1).run({
    ...options,
    file: new URL('./empty.js', import.meta.url),
  })
);
await attempt(() =>
  compare(
    bench('twin', () => 1),
    bench('twin', () => 2)
  )
);

console.log(JSON.stringify(messages));
