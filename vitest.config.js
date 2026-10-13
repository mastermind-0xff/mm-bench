import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // code running in workers (worker.ts, the worker side of bench.ts) is
    // tested end to end, out of the coverage's sight
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/fixtures/**', 'src/types.ts'],
      reporter: ['text', 'html'],
      thresholds: { statements: 90, branches: 75, functions: 90, lines: 90 },
    },
  },
});
