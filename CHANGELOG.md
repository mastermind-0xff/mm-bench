# Changelog

## Unreleased

First release: microbenchmarks with run time distributions, every sample
in a fresh worker thread, with CPU and memory probes, plotted side by side
with mm-logger.

### Added

- **`bench(name, fn, options?)`** creates a case, sync or async;
  **`compare(...cases, options?)`** and **`case.run(options?)`** measure
  cases side by side, their samples interleaved, and resolve with the
  report. Workers get the cases by running the bench file again, up to the
  call they measure; **`isWorker()`** tells the bench file it runs in one.
- **Budgets**: `time: 'auto'` (2 s to 10 s per case, from its speed),
  a fixed `time` or an exact number of `runs`, split between `samples`
  (4 by default), each with its own warm-up.
- **Timer handling**: the timer's resolution is measured at runtime, its
  overhead is calibrated by each sample and subtracted (`subtractOverhead`),
  and `batchSize` times several calls per run for functions faster than
  the timer.
- **Raw data**: an exact histogram of every run per case and sample, and
  ticks (CPU and memory probes between runs) as cumulative columns, plus
  the machine's cores probed from the main thread.
- **`loggerReporter(options?)`**: a column per case with its stats, hints
  (batch size, few runs, busy machine) and graphs: distribution, mean run
  time over the sample, the function's thread, all cores, delta and total
  heap, and the machine's cores. Compared cases share every scale. Then a
  summary table of the cases (`summary`): mean, median, p99, ops/s and how
  much slower than the fastest by default, any fields of `SUMMARY_FIELDS`.
- **`distribution(report, options?)`**: run times in equal buckets over a
  shared range, widths whole multiples of the timer's step, sparse
  outliers trimmed; **`caseSeries`**, **`computeStats`** and
  **`mergeHistograms`** for your own plots.
- **Security**: the workers import only local script files inside `root`
  (`process.cwd()` by default), once symlinks and junctions are resolved;
  case names are escaped in the report and in error messages.
- **Timeouts**: a sample that makes no progress for `timeout` ms (60 s by
  default) is stopped, with the end of its worker's stderr in the error.
- ESM and CommonJS builds with type declarations; Node.js 22 or newer.
