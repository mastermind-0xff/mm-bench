# Demos

Each file is a complete bench script. Build once, then run any of them:

```sh
npm run build
node demo/compare.js
```

The demos import `mm-bench` by its package name, which resolves to this
repository's `dist` build. Wider terminals put the compared cases side by
side; in a narrow one (or when the output is piped) they are stacked. Set
`NO_COLOR=1` for plain text.

| Demo               | Shows                                                                                                                                             | Time  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `distribution.js`  | A case with a known distribution, 30% 2µs, 60% 4µs, 10% 6µs: the graph should show the three peaks.                                               | ~3 s  |
| `compare.js`       | Three ways to build a string, compared: interleaved samples, shared axes, fastest and how much slower.                                            | ~8 s  |
| `async.js`         | Async cases (awaited on every call) and `time: 'auto'` giving slower cases more time; file reads use libuv's thread pool, seen in the CPU graphs. | ~9 s  |
| `cpu-all-cores.js` | The same work on one thread and on a helper thread per core: all cores busy, and what the rest of the machine leaves for them.                    | ~20 s |
| `cpu.js`           | The same hashing on the function's thread, on one pool thread and on four: the function's thread, all cores usage, and the machine's cores.       | ~30 s |
| `batch.js`         | A function faster than the timer's step: timed one call per run, then in batches of 100 (`batchSize`). The report hints at the batch size.        | ~5 s  |
| `memory.js`        | Allocating on every call versus reusing: the delta and total heap graphs, GC pauses in the timeline.                                              | ~6 s  |
| `raw-data.js`      | `output: false`: the raw report (stats, histogram, ticks) and a custom plot with your own mm-logger.                                              | ~2 s  |

## Writing your own

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { bench, compare, isWorker } from 'mm-bench';

const input = prepare(); // top-level data is prepared in the workers too
// side effects the cases don't need: once, not in every worker
if (!isWorker()) mkdirSync('results', { recursive: true });

const report = await compare(
  bench('current', () => current(input)),
  bench('candidate', () => candidate(input))
);

// after the last call: runs once, on the main thread
writeFileSync('results/report.json', JSON.stringify(report));
```

- Every sample runs in a fresh worker, which imports your script again and
  measures one case when it reaches its call.
- Return the result of the work from the case (`() => current(input)`), so
  V8 can't drop the call as dead code.
- Defaults: 4 samples, `time: 'auto'` (2 s to 10 s per case, aiming at
  10,000 runs), 100 ms warm-up per sample. Pass options to `bench` (per
  case) or as the last argument of `compare` (all cases), e.g.
  `{ runs: 100_000 }`, `{ time: 5000 }` or `{ batchSize: 100 }`.

The [main README](../README.md) has every option, the report's data and
[how to read the graphs](../README.md#reading-the-graphs).
