import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from './index.js';

/**
 * Checks of the build (`npm test` builds first): vitest runs the sources,
 * the package ships what the bundler made of them.
 */

type Exports = Record<string, unknown>;

const requireBuilt = createRequire(import.meta.url);
const dist = new URL('../dist/', import.meta.url);

const esmOf = async (name: string): Promise<Exports> =>
  (await import(new URL(`esm/${name}.js`, dist).href)) as Exports;
const cjsOf = (name: string): Exports =>
  requireBuilt(fileURLToPath(new URL(`cjs/${name}.cjs`, dist))) as Exports;
const namesOf = (exports: Exports): string[] =>
  Object.keys(exports)
    .filter((name) => name !== '__esModule')
    .sort();

/**
 * Source modules with runtime code: all but the specs, the types and the
 * worker entry, which reads its task when imported.
 */
const modules = readdirSync(new URL('.', import.meta.url))
  .filter(
    (file) =>
      file.endsWith('.ts') &&
      !file.endsWith('.spec.ts') &&
      !['types.ts', 'worker.ts'].includes(file)
  )
  .map((file) => file.slice(0, -'.ts'.length));

describe('the package', () => {
  it('exports the public API', () => {
    expect(namesOf(api)).toEqual([
      'DEFAULT_AUTO_TIME',
      'DEFAULT_BUCKETS',
      'DEFAULT_GRAPHS',
      'DEFAULT_MEASURE_OPTIONS',
      'DEFAULT_TRIM',
      'GRAPH_NAMES',
      'MACHINE_WINDOW',
      'bench',
      'caseSeries',
      'compare',
      'computeStats',
      'distribution',
      'isWorker',
      'loggerReporter',
      'mergeHistograms',
    ]);
  });

  it('builds ESM and CJS with the same API', async () => {
    expect(namesOf(await esmOf('index'))).toEqual(namesOf(api));
    expect(namesOf(cjsOf('index'))).toEqual(namesOf(api));
  });

  // the bundler once dropped `sink`, which nothing reads: see rollup.config.js
  it.each(modules)('keeps every export of %s.ts in the build', async (name) => {
    const source = namesOf((await import(`./${name}.ts`)) as Exports);
    expect(namesOf(await esmOf(name))).toEqual(source);
    expect(namesOf(cjsOf(name))).toEqual(source);
  });
});
