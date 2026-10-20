// The built-in report, without colors.
import { bench, compare, loggerReporter } from '@mmutils/bench';

await compare(
  bench('fast', () => 1),
  bench('slow', () => {
    let total = 0;
    for (let index = 0; index < 1000; index++) total += index;
    return total;
  }),
  {
    runs: 2000,
    samples: 2,
    warmup: { runs: 100 },
    output: loggerReporter({ colors: false, width: 50, columns: 2 }),
  }
);
