/**
 * The raw data, without the built-in report: `output: false` returns the
 * report only. Every number the reporter prints comes from it, so you can
 * plot it your own way, store it, or compare it with a saved run.
 *
 * Run: node demo/raw-data.js
 */
import { Logger, graphPlugin, messagePlugin } from '@mmutils/logger';
import { bench, distribution } from '@mmutils/bench';

const report = await bench('sort 100 numbers', () =>
  Array.from({ length: 100 }, (_, index) => (index * 7919) % 101).sort(
    (a, b) => a - b
  )
).run({ output: false, samples: 2, time: 1000 });

// code after the last call runs on the main thread only: the workers stop
// at the call they measure
const [sorted] = report.cases;
const { stats, histogram, samples } = sorted;
console.log('stats (ns):', stats);
const [{ ticks, machine }] = samples;
console.log(
  `histogram: ${histogram.durations.length} distinct times, ${samples.length} samples,`,
  `first ticks of sample 1: ${ticks.time.slice(0, 3).join(', ')} ns`
);
// cumulative counters: CPU µs over wall ns, per thread and per process
const span = ticks.time.at(-1);
console.log(
  `sample 1: function's thread ${((ticks.threadCpu.at(-1) * 1e5) / span).toFixed(0)}% of a core,`,
  `process ${((ticks.cpu.at(-1) * 1e3) / span).toFixed(2)} cores,`,
  `${machine.time.length} machine probes of ${machine.busy.length} cores`
);

// a custom plot: 40 buckets, no trimming, with your own logger
const { start, end, cases } = distribution(report, { buckets: 40, trim: 0 });
const logger = new Logger({ plugins: [messagePlugin(), graphPlugin()] });
logger.info('Every run, nothing trimmed:');
logger.infoGraph(cases[0].percents, {
  cols: 40,
  rows: 6,
  title: 'sort 100 numbers',
  unit: '%',
  axis: { start, end, unit: 'ns' },
});
