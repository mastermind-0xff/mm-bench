// Several calls in one file: each worker skips the calls before its own.
import { bench, compare } from '@mmutils/bench';

const options = { runs: 100, samples: 2, warmup: { runs: 10 }, output: false };

const first = await compare(
  bench('a1', () => 1),
  bench('a2', () => 2),
  options
);
const second = await bench('b', () => 3).run(options);
const third = await compare(
  bench('c1', () => 4),
  bench('c2', () => 5),
  options
);

console.log(
  JSON.stringify(
    [first, second, third].map(({ cases }) =>
      cases.map(({ name, stats }) => `${name}:${stats.runs}`)
    )
  )
);
