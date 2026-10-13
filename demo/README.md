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
import { bench, compare } from 'mm-bench';

const input = prepare(); // top-level data is prepared in the workers too

await compare(
  bench('current', () => current(input)),
  bench('candidate', () => candidate(input))
);
```

- Every sample runs in a fresh worker, which imports your script again and
  measures one case when it reaches its call. Code before the call runs in
  every worker; code after the last call runs only once, on the main
  thread.
- Return the result of the work from the case (`() => current(input)`), so
  V8 can't drop the call as dead code.
- Defaults: 4 samples, `time: 'auto'` (2 s to 10 s per case, aiming at
  10,000 runs), 100 ms warm-up per sample. Pass options to `bench` (per
  case) or as the last argument of `compare` (all cases), e.g.
  `{ runs: 100_000 }`, `{ time: 5000 }` or `{ batchSize: 100 }`.

## Reading the graphs

Graphs over the sample show their average, min and max under the bars;
the number on the title row is the top of the scale, shared by the
compared cases, so the case that stands out shows.

### Memory

- **Delta heap**: the worker's V8 heap above its thread cost, the heap it
  holds when measuring starts, right after a full garbage collection (V8's
  own, the modules, your file's data; about 6–8 MB). What rises above 0 is
  the case's: garbage piling up until a collection, or retained memory as
  a rising trend.
- **Total heap used**: the same with the thread cost, which hides small
  footprints.
- Fast cases show a floor of about 1 MB in Delta heap: mm-bench's own
  timer allocates on every read (Node 22 has no nanosecond timer that
  doesn't), and V8's young generation fills with it and empties. It is
  the same for every case; a case's own memory rises above it.

### CPU

- **Function's thread**, 0–100% of a core: the worker thread calling the
  function. Sync work keeps it near 100%; it drops while the function
  waits for I/O, timers or other threads.
- **All cores usage**, in percent of all the machine's cores: the whole
  process, every thread: the function's, V8's garbage collector and
  compiler, libuv's thread pool (async file I/O, crypto, zlib) and
  mm-bench's main thread. One busy thread on 12 cores is 8%.
- **Machine cores**, not drawn by default (`cpu.js` and `cpu-all-cores.js`
  add it): every logical core of the machine, all processes, from
  `os.cpus()`. Threads move between cores, so one busy thread can show as
  several partly busy cores. `other processes` is what the rest of the
  machine used meanwhile.
- **Busy machine**: when other processes use 10% of the machine's CPU or
  more while a case is measured, the case gets a warning, whichever graphs
  are drawn: they compete for the cores, so expect noisier numbers.
- Windows counts CPU time in steps of 15.6 ms, so its CPU graphs use
  windows of at least 62.5 ms (125 ms for the machine's cores).
