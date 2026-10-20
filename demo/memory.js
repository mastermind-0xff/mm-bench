/**
 * Memory: one case allocates a new array of objects on every call, the
 * other reuses one.
 *
 * - "Delta heap": the heap above the thread's cost (what the worker holds
 *   before measuring, about 8 MB): the first case's garbage piling up and
 *   being collected, the second case near 0.
 * - "Total heap used": the same with the thread's cost, which hides small
 *   footprints.
 *
 * GC pauses show in the timeline and in the slow tail of the distribution.
 *
 * Run: node demo/memory.js
 */
import { bench, compare } from '@mmutils/bench';

const size = 1000;
const reused = Array.from({ length: size }, () => ({ x: 0, y: 0 }));

await compare(
  bench('allocate', () =>
    Array.from({ length: size }, (_, index) => ({ x: index, y: index * 2 }))
  ),
  bench('reuse', () => {
    for (let index = 0; index < size; index++) {
      const point = reused[index];
      point.x = index;
      point.y = index * 2;
    }
    return reused;
  })
);
