// A sync and an async case compared, the raw data summed up as JSON.
import { bench, compare } from '@mmutils/bench';

const report = await compare(
  bench('sync', () => Math.sqrt(Math.random())),
  bench('async', async () => Math.random()),
  { runs: 200, samples: 2, warmup: { runs: 20 }, output: false }
);

console.log(
  JSON.stringify(
    report.cases.map(({ name, async, stats, histogram, samples }) => ({
      name,
      async,
      runs: stats.runs,
      counted: histogram.counts.reduce((sum, count) => sum + count, 0),
      samples: samples.length,
      ticks: samples.every(
        ({ ticks }) => ticks.time.length >= 2 && ticks.time[0] === 0
      ),
    }))
  )
);
