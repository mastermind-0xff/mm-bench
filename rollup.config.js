import typescript from '@rollup/plugin-typescript';

const typescriptPlugin = () =>
  typescript({
    tsconfig: './tsconfig.build.json',
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    outDir: undefined,
  });

// @mmutils/logger is loaded lazily, only by the logger reporter, so workers and
// `output: false` never load it
const external = ['@mmutils/logger', /^node:/];

// the worker entry is an input of its own: workers load it by URL, nothing
// imports it
const input = ['src/index.ts', 'src/worker.ts'];

// no tree-shaking: the measuring loops store results in `sink`, which
// nothing reads, so V8 can't drop the measured calls as dead code; rollup
// would drop those stores (and the empty calls timing the overhead) as
// unused, measuring something else than the sources do
const treeshake = false;

export default [
  {
    input,
    external,
    treeshake,
    plugins: [typescriptPlugin()],
    output: {
      dir: 'dist/esm',
      format: 'esm',
      entryFileNames: '[name].js',
      preserveModules: true,
      preserveModulesRoot: 'src',
      sourcemap: true,
    },
  },
  {
    input,
    external,
    treeshake,
    plugins: [typescriptPlugin()],
    output: {
      dir: 'dist/cjs',
      format: 'cjs',
      entryFileNames: '[name].cjs',
      preserveModules: true,
      preserveModulesRoot: 'src',
      exports: 'named',
      sourcemap: true,
    },
  },
];
