import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Extensions of files the workers may import. */
export const BENCH_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
]);

/** A validated file for the workers to import. */
export interface BenchFile {
  /** Real path: symlinks resolved, canonical case. */
  readonly path: string;
  /** `file:` URL of `path`, for `import()`; also the file's identity. */
  readonly url: string;
}

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

const toPath = (file: string | URL): string => {
  if (
    typeof file === 'string' &&
    (WINDOWS_DRIVE.test(file) || !URL_SCHEME.test(file))
  )
    return resolve(file);
  let url: URL;
  try {
    url = typeof file === 'string' ? new URL(file) : file;
  } catch {
    throw new TypeError(`mm-bench: file is not a valid URL: ${String(file)}.`);
  }
  if (url.protocol !== 'file:')
    throw new TypeError(
      `mm-bench: file must be a path or a file: URL, got a ${url.protocol} URL.`
    );
  return fileURLToPath(url);
};

const realPath = (path: string, what: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    throw new Error(`mm-bench: ${what} not found: ${path}.`);
  }
};

/**
 * Resolves and checks the file the workers import: a local, regular file
 * with a script extension, inside `root` once symlinks are resolved. URLs
 * other than `file:` (`data:`, `http:`, …) are rejected.
 *
 * @param file Path or `file:` URL. Default: the entry script
 * (`process.argv[1]`).
 * @param root Directory the file must be inside. Default: `process.cwd()`.
 * @throws TypeError for anything that isn't a path or a `file:` URL, Error
 * for missing files and files outside `root` or of other kinds.
 */
export const resolveBenchFile = (
  file: string | URL | undefined,
  root: string | undefined
): BenchFile => {
  const input = file ?? process.argv[1];
  if (input === undefined || input === '')
    throw new Error(
      'mm-bench: no entry script to run in the workers. Pass { file: import.meta.url } (or __filename).'
    );
  if (typeof input !== 'string' && !(input instanceof URL))
    throw new TypeError(
      `mm-bench: file must be a path or a file: URL, got ${typeof input}.`
    );
  if (root !== undefined && typeof root !== 'string')
    throw new TypeError(`mm-bench: root must be a path, got ${typeof root}.`);
  const realRoot = realPath(resolve(root ?? process.cwd()), 'root');
  const path = realPath(toPath(input), 'file');
  const inRoot = relative(realRoot, path);
  if (
    inRoot === '' ||
    inRoot === '..' ||
    inRoot.startsWith(`..${sep}`) ||
    isAbsolute(inRoot)
  )
    throw new Error(
      `mm-bench: ${path} is outside the root ${realRoot}. Set the root option to a directory that contains it.`
    );
  if (!statSync(path).isFile())
    throw new Error(`mm-bench: ${path} is not a file.`);
  if (!BENCH_FILE_EXTENSIONS.has(extname(path).toLowerCase()))
    throw new Error(
      `mm-bench: ${path} is not a script: expected ${[...BENCH_FILE_EXTENSIONS].join(' ')}.`
    );
  return { path, url: pathToFileURL(path).href };
};
