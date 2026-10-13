import { describe, expect, it } from 'vitest';
import { environmentOf, sampleOf } from './fixtures/reports.js';
import { resolveMeasureOptions } from './options.js';
import { buildReport } from './report.js';

describe('buildReport', () => {
  const options = resolveMeasureOptions({ runs: 10 });

  it('merges samples and computes stats without the overhead', () => {
    const report = buildReport(
      [
        {
          name: 'a',
          options,
          measurements: [
            {
              async: false,
              sample: sampleOf({ durations: [110], counts: [2] }, 10),
            },
            {
              async: false,
              sample: sampleOf({ durations: [130], counts: [2] }, 30),
            },
          ],
        },
      ],
      environmentOf(),
      12
    );
    const [a] = report.cases;
    expect(report.duration).toBe(12);
    expect(a!.histogram).toEqual({ durations: [110, 130], counts: [2, 2] });
    expect(a!.overhead).toBe(20);
    expect(a!.stats).toMatchObject({ runs: 4, mean: 100, min: 90 });
    expect(a!.samples).toHaveLength(2);
    expect(a!.relative).toBe(1);
  });

  it('keeps the overhead when subtractOverhead is off', () => {
    const report = buildReport(
      [
        {
          name: 'a',
          options: resolveMeasureOptions({ subtractOverhead: false }),
          measurements: [
            {
              async: true,
              sample: sampleOf({ durations: [110], counts: [1] }, 10),
            },
          ],
        },
      ],
      environmentOf(),
      0
    );
    expect(report.cases[0]).toMatchObject({
      async: true,
      stats: { mean: 110 },
    });
  });

  it('compares each case with the fastest', () => {
    const caseOf = (name: string, duration: number) => ({
      name,
      options,
      measurements: [
        {
          async: false,
          sample: sampleOf({ durations: [duration], counts: [1] }),
        },
      ],
    });
    const report = buildReport(
      [caseOf('slow', 300), caseOf('fast', 200)],
      environmentOf(),
      0
    );
    expect(report.cases.map(({ name, relative }) => [name, relative])).toEqual([
      ['slow', 1.5],
      ['fast', 1],
    ]);
  });
});
