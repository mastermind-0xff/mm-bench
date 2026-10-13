import typescript from '@rollup/plugin-typescript';

const typescriptPlugin = () =>
  typescript({
    tsconfig: './tsconfig.build.json',
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    outDir: undefined,
  });

// mm-logger is loaded lazily, only by the logger reporter, so workers and
// `output: false` never load it
const external = ['mm-logger', /^node:/];

// the worker entry is an input of its own: workers load it by URL, nothing
// imports it
const input = ['src/index.ts', 'src/worker.ts'];

export default [
  {
    input,
    external,
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
