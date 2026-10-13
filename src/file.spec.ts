import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBenchFile } from './file.js';

describe('resolveBenchFile', () => {
  let base: string;
  let root: string;
  let script: string;
  let outside: string;

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mm-bench-')));
    root = join(base, 'root');
    mkdirSync(join(root, 'sub'), { recursive: true });
    script = join(root, 'bench.js');
    writeFileSync(script, '');
    writeFileSync(join(root, 'notes.txt'), '');
    outside = join(base, 'outside.js');
    writeFileSync(outside, '');
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('accepts a script inside the root, by path or file: URL', () => {
    const expected = { path: script, url: pathToFileURL(script).href };
    expect(resolveBenchFile(script, root)).toEqual(expected);
    expect(resolveBenchFile(pathToFileURL(script).href, root)).toEqual(
      expected
    );
    expect(resolveBenchFile(pathToFileURL(script), root)).toEqual(expected);
  });

  it('accepts every script extension', () => {
    for (const extension of ['.mjs', '.cjs', '.ts', '.mts', '.cts']) {
      const file = join(root, `case${extension}`);
      writeFileSync(file, '');
      expect(resolveBenchFile(file, root).path).toBe(file);
    }
  });

  it('rejects files outside the root', () => {
    expect(() => resolveBenchFile(outside, root)).toThrow(/outside the root/);
    expect(() =>
      resolveBenchFile(join(root, '..', 'outside.js'), root)
    ).toThrow(/outside the root/);
  });

  it('rejects directories, other extensions and missing files', () => {
    expect(() => resolveBenchFile(join(root, 'sub'), root)).toThrow(
      /not a file/
    );
    expect(() => resolveBenchFile(join(root, 'notes.txt'), root)).toThrow(
      /not a script/
    );
    expect(() => resolveBenchFile(join(root, 'missing.js'), root)).toThrow(
      /not found/
    );
    expect(() => resolveBenchFile(script, join(base, 'nowhere'))).toThrow(
      /root not found/
    );
  });

  it('rejects URLs other than file:', () => {
    expect(() =>
      resolveBenchFile('https://example.com/bench.js', root)
    ).toThrow(TypeError);
    expect(() =>
      resolveBenchFile('data:text/javascript,console.log(1)', root)
    ).toThrow(TypeError);
    expect(() =>
      resolveBenchFile(new URL('https://example.com/bench.js'), root)
    ).toThrow(TypeError);
  });

  it('rejects values that are not paths', () => {
    expect(() => resolveBenchFile(5 as never, root)).toThrow(TypeError);
    expect(() => resolveBenchFile(script, 5 as never)).toThrow(TypeError);
  });

  it('follows directory links before checking the root', () => {
    // a junction needs no privileges on Windows; elsewhere it's a symlink
    const away = join(base, 'away');
    mkdirSync(away, { recursive: true });
    writeFileSync(join(away, 'bench.js'), '');
    const link = join(root, 'linked');
    symlinkSync(away, link, 'junction');
    expect(() => resolveBenchFile(join(link, 'bench.js'), root)).toThrow(
      /outside the root/
    );
  });

  it('follows symlinks before checking the root', (context) => {
    const link = join(root, 'link.js');
    try {
      symlinkSync(outside, link);
    } catch {
      context.skip(); // creating symlinks needs privileges on Windows
    }
    expect(() => resolveBenchFile(link, root)).toThrow(/outside the root/);
  });
});
