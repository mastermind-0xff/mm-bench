import { execFile } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bench, compare, isWorker } from './bench.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const availableCores = (): number => cpus().length;

/**
 * Runs a fixture with node, as a user would: it imports the built package
 * (`npm test` builds first).
 */
const runFixture = (
  name: string
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))],
      { cwd: root, env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`${name} failed: ${stderr}`, { cause: error }));
        else resolve({ stdout, stderr });
      }
    );
  });

const jsonOf = async (name: string): Promise<unknown> =>
  JSON.parse((await runFixture(name)).stdout) as unknown;

describe('bench', () => {
  it('creates a case without running it', () => {
    const fn = () => 1;
    const created = bench('name', fn, { runs: 5 });
    expect(created).toMatchObject({ name: 'name', fn, options: { runs: 5 } });
    expect(typeof created.run).toBe('function');
  });

  it('rejects bad cases right away', () => {
    expect(() => bench('', () => 1)).toThrow(TypeError);
    expect(() => bench('a', 5 as never)).toThrow(TypeError);
    expect(() => bench('a', () => 1, { tme: 1 } as never)).toThrow(/'tme'/);
    expect(() => bench('a', () => 1, { samples: 0 })).toThrow(RangeError);
    expect(() => bench('a', () => 1, { file: 'x' } as never)).toThrow(
      TypeError
    );
  });

  it('escapes control characters of names in errors', async () => {
    expect(() => bench('bad\x1b[2J', 5 as never)).toThrow(
      'case "bad\\x1b[2J" needs a function'
    );
    await expect(
      compare(
        bench('tw\x07in', () => 1),
        bench('tw\x07in', () => 2)
      )
    ).rejects.toThrow('named "tw\\x07in"');
  });
});

describe('compare', () => {
  it('rejects calls without cases or with other values', async () => {
    await expect(compare()).rejects.toThrow(/nothing to measure/);
    await expect(compare({ runs: 1 })).rejects.toThrow(/nothing to measure/);
    await expect(
      compare(
        5 as never,
        bench('a', () => 1)
      )
    ).rejects.toThrow(/argument 1/);
  });

  it('rejects twin names and bad options', async () => {
    await expect(
      compare(
        bench('twin', () => 1),
        bench('twin', () => 2)
      )
    ).rejects.toThrow(/named "twin"/);
    await expect(
      compare(
        bench('a', () => 1),
        { outptu: false } as never
      )
    ).rejects.toThrow(/'outptu'/);
    await expect(
      compare(
        bench('a', () => 1),
        { output: 'yes' } as never
      )
    ).rejects.toThrow(/output/);
    await expect(
      compare(
        bench('a', () => 1),
        { file: 'https://example.com/x.js' }
      )
    ).rejects.toThrow(TypeError);
  });

  it('is not in a worker on the main thread', () => {
    expect(isWorker()).toBe(false);
  });

  it('runs samples in workers from the sources', async () => {
    const report = await compare(
      bench('target', () => 0),
      {
        file: new URL('./fixtures/target.js', import.meta.url),
        runs: 50,
        samples: 2,
        warmup: { runs: 5 },
        output: false,
      }
    );
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]).toMatchObject({
      name: 'target',
      async: false,
      stats: { runs: 50 },
    });
    expect(report.cases[0]!.samples).toHaveLength(2);
    const { ticks, machine } = report.cases[0]!.samples[0]!;
    // the machine's probes span the measuring
    expect(machine.time[0]).toBeLessThanOrEqual(0);
    expect(machine.time.at(-1)).toBeGreaterThanOrEqual(ticks.time.at(-1)!);
    expect(machine.busy).toHaveLength(availableCores());
    expect(report.environment.timerResolution).toBeGreaterThan(0);
  });
});

describe('end to end', { timeout: 60_000 }, () => {
  it('measures sync and async cases in workers', async () => {
    expect(await jsonOf('compare.js')).toEqual([
      {
        name: 'sync',
        async: false,
        runs: 200,
        counted: 200,
        samples: 2,
        ticks: true,
      },
      {
        name: 'async',
        async: true,
        runs: 200,
        counted: 200,
        samples: 2,
        ticks: true,
      },
    ]);
  });

  it('runs several calls of one file, in order', async () => {
    expect(await jsonOf('groups.js')).toEqual([
      ['a1:100', 'a2:100'],
      ['b:100'],
      ['c1:100', 'c2:100'],
    ]);
  });

  it('works from CommonJS without top-level await', async () => {
    expect(await jsonOf('cjs.cjs')).toEqual(['first', 'second', 'third']);
  });

  it('rejects with clear errors', async () => {
    const [throws, never, stuck, elsewhere, twins] = (await jsonOf(
      'errors.js'
    )) as string[];
    expect(throws).toMatch(/"throws" \(sample 1\) failed: Error: boom/);
    expect(never).toMatch(/"never settles" .* ran out of work/);
    expect(stuck).toMatch(/"stuck" .* made no progress for 300 ms/);
    expect(elsewhere).toMatch(/never reached the call/);
    expect(twins).toMatch(/named "twin"/);
  });

  it('prints the report side by side', async () => {
    const { stdout } = await runFixture('reporter.js');
    for (const text of [
      'mm-bench',
      'sample 1/2',
      'sample 2/2',
      'fast',
      'fastest',
      'slower',
      'Run time, % of runs',
      'Mean run time over the sample',
      "Function's thread, % of a core",
      'All cores usage',
      'Delta heap, thread cost',
      'Total heap used',
    ])
      expect(stdout).toContain(text);
    expect(stdout).not.toContain('\x1b[');
    // two columns: the titles share a line
    expect(stdout).toMatch(/fast .*fastest.*\|.*slow .*slower/);
  });
});
