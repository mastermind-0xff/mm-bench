// Measured by the tests from the TypeScript sources: the workers run this
// file, the test calls compare with the same cases.
import { bench, compare } from '@mmutils/bench';

await compare(
  bench('target', () => Math.sqrt(2)),
  {
    file: import.meta.url,
    output: false,
  }
);
