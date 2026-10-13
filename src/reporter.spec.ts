import { describe, expect, it } from 'vitest';
import { machineOf, reportOf } from './fixtures/reports.js';
import { loggerReporter } from './reporter.js';
import type { Report } from './types.js';

const report = reportOf(
  [
    { name: 'quick', durations: [200, 400, 600], counts: [30, 60, 10] },
    {
      name: 'slow\x1b[2J',
      durations: [900, 1000],
      counts: [5, 5],
      async: true,
    },
    { name: 'tiny', durations: [3], counts: [5], options: { runs: 5 } },
  ],
  100
);

const render = async (
  value: Report,
  options: Parameters<typeof loggerReporter>[0] = {}
): Promise<string> => {
  const lines: string[] = [];
  const reporter = loggerReporter({
    colors: false,
    width: 44,
    columns: 3,
    write: (text) => lines.push(text),
    ...options,
  });
  const cases = value.cases.map(({ name, options: caseOptions }) => ({
    name,
    options: caseOptions,
  }));
  await reporter.start?.({ cases, environment: value.environment });
  const [first] = value.cases;
  if (first !== undefined)
    await reporter.sample?.({
      case: first.name,
      sample: 1,
      samples: 1,
      async: first.async,
      result: first.samples[0]!,
    });
  await reporter.end?.(value);
  return lines.join('\n');
};

describe('loggerReporter', () => {
  it('prints a header, progress and one column per case', async () => {
    const text = await render(report);
    expect(text).toContain('mm-bench  node v22.0.0');
    expect(text).toContain('timer step 100ns');
    expect(text).toContain('3 cases · 4 samples');
    expect(text).toMatch(/sample 1\/1 {2}quick {2}100 runs/);
    expect(text).toMatch(
      /quick .*× slower .*\|.*slow\\x1b\[2J async .*× slower .*\|.*tiny .*fastest/
    );
    expect(text).toContain('Run time, % of runs');
    expect(text).not.toContain('\x1b');
  });

  it('escapes control characters of the CPU name', async () => {
    const text = await render({
      ...report,
      environment: { ...report.environment, cpu: 'Odd\x1b]0;title\x07 CPU' },
    });
    expect(text).toContain('Odd\\x1b]0;title\\x07 CPU');
    expect(text).not.toContain('\x1b');
  });

  it('hints at coarse timers and few runs', async () => {
    const text = await render(report);
    expect(text).toContain('try batchSize');
    expect(text).toContain('rough distribution');
  });

  it("draws all graphs but the machine's by default", async () => {
    const text = await render(report);
    for (const title of [
      'Run time, % of runs',
      'Mean run time over the sample',
      "Function's thread, % of a core",
      'All cores usage, % of 4 cores',
      'Delta heap, thread cost 4.0 MB',
      'Total heap used',
    ])
      expect(text).toContain(title);
    expect(text).not.toContain('Machine cores');
  });

  it('shows average, min and max of the graphs over the sample', async () => {
    const lines = (
      await render(report, { graphs: ['cores'], columns: 1, width: 40 })
    ).split('\n');
    // 1 of the 4 cores, all along
    const legend = lines.findIndex((line) =>
      line.startsWith('All cores usage, % of 4 cores ')
    );
    expect(lines[legend]).toMatch(/ 25\.0 %$/);
    expect(lines.slice(legend + 5, legend + 8)).toEqual([
      'average: 25.0 %                    0.0 %',
      'min: 25.0 %',
      'max: 25.0 %',
    ]);
    const distribution = await render(report, { graphs: ['distribution'] });
    expect(distribution).not.toContain('average:');
  });

  it('warns when other processes kept the machine busy', async () => {
    // 1.75 of 4 cores busy, 1 of them by this process: 19% by others
    const wide = { graphs: [], columns: 1, width: 80 } as const;
    expect(await render(report, wide)).toContain(
      '! busy machine: other processes used 19% CPU'
    );
    const quiet: Report = {
      ...report,
      cases: report.cases.map((caseReport) => ({
        ...caseReport,
        samples: caseReport.samples.map((sample) => ({
          ...sample,
          machine: machineOf(sample.ticks.time.at(-1) ?? 0, 10, [1, 0, 0, 0]),
        })),
      })),
    };
    expect(await render(quiet, wide)).not.toContain('busy machine');
  });

  it('draws the chosen graphs only', async () => {
    const text = await render(report, { graphs: ['cores'] });
    expect(text).toContain('All cores usage');
    expect(text).not.toContain('Run time, % of runs');
    expect(text).not.toContain("Function's thread");
    expect(text).not.toContain('Delta heap');
    expect(text).not.toContain('Total heap used');
  });

  it("draws a strip per core of the machine's", async () => {
    const text = await render(report, { graphs: ['machine'], columns: 1 });
    expect(text).toContain('Machine cores, all processes');
    const strips = text.split('\n').filter((line) => line.includes('│'));
    // 4 cores, 3 cases
    expect(strips).toHaveLength(12);
    expect(strips[0]).toMatch(/^0 │█+│ 100%$/);
    expect(strips[1]).toMatch(/^1 │▄+│ {2}50%$/);
    expect(strips[2]).toMatch(/^2 │▂+│ {2}25%$/);
    expect(strips[3]).toMatch(/^3 │ +│ {3}0%$/);
    expect(strips[0]).toHaveLength(44);
    // 1.75 of 4 cores busy, 1 of them by this process
    expect(text).toMatch(/busy: 44% +other processes: 19%/);
  });

  it('stacks cases in fewer columns', async () => {
    const text = await render(report, { columns: 1, progress: false });
    expect(text).not.toContain(' | ');
    expect(text).not.toContain('sample 1/1');
  });

  it('prints nothing for an empty report', async () => {
    const lines: string[] = [];
    const reporter = loggerReporter({ write: (line) => lines.push(line) });
    await reporter.end?.({ ...report, cases: [] });
    expect(lines).toEqual([]);
  });

  it('rejects invalid options', () => {
    expect(() => loggerReporter({ width: 5 })).toThrow(RangeError);
    expect(() => loggerReporter({ columns: 0 })).toThrow(RangeError);
    expect(() => loggerReporter({ graphs: ['pie'] as never })).toThrow(
      RangeError
    );
    expect(() => loggerReporter({ buckets: 0 })).toThrow(RangeError);
    expect(() => loggerReporter({ trim: 1 })).toThrow(RangeError);
    expect(() => loggerReporter({ write: 'x' as never })).toThrow(RangeError);
  });
});
