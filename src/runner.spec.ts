import { describe, expect, it } from 'vitest';
import { resolveBenchFile } from './file.js';
import { environmentOf } from './fixtures/reports.js';
import { resolveMeasureOptions, sampleBudget } from './options.js';
import type { WorkerTask } from './protocol.js';
import { runSample } from './runner.js';
import type { MeasureOptions } from './types.js';

/** The cases of the fixture's measured call, its second. */
const NAMES = ['in a worker', 'exits', 'throws later', 'stuck', 'slow warm-up'];

const file = resolveBenchFile(
  new URL('./fixtures/runner.js', import.meta.url),
  undefined
).url;

/**
 * Measures one sample of a fixture case in a worker, as `compare` does.
 *
 * @param name Case to measure, from `NAMES`.
 * @param names Names the main thread sends: by default the fixture's.
 */
const run = (
  name: string,
  options: MeasureOptions = {},
  names: readonly string[] = NAMES
) => {
  const resolved = resolveMeasureOptions(
    { runs: 2, samples: 1, warmup: { runs: 1 } },
    options
  );
  const task: WorkerTask = {
    file,
    entry: undefined,
    call: 1,
    case: Math.max(0, names.indexOf(name)),
    names,
    sample: 0,
    budget: sampleBudget(resolved, 0),
    options: resolved,
    environment: { ...environmentOf(), cpu: 'main thread CPU' },
  };
  return runSample(task, { name, timeout: resolved.timeout });
};

describe('runSample', { timeout: 30_000 }, () => {
  it('measures a case in a worker, earlier calls getting the main environment', async () => {
    const { async, sample } = await run('in a worker');
    expect(async).toBe(false);
    expect(sample.runs).toBe(2);
    expect(sample.machine.time.length).toBeGreaterThan(0);
  });

  it('never stops a worker for an endless timeout', async () => {
    // setTimeout takes Infinity as 1 ms: no timer must be set at all
    const { sample } = await run('in a worker', { timeout: Infinity });
    expect(sample.runs).toBe(2);
  });

  it('keeps a slow warm-up alive while each run is within the timeout', async () => {
    // 60 runs of 50 ms: a 3 s warm-up, with progress every 250 ms
    const { sample } = await run('slow warm-up', {
      warmup: { runs: 60 },
      timeout: 2000,
    });
    expect(sample.runs).toBe(2);
  });

  it('rejects when the worker exits', async () => {
    await expect(run('exits')).rejects.toThrow(
      'mm-bench: the worker of "exits" (sample 1) exited with code 3 before finishing.'
    );
  });

  it('rejects with the error the worker failed with', async () => {
    const error = await run('throws later').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'mm-bench: "throws later" (sample 1) failed.'
    );
    expect(((error as Error).cause as Error).message).toMatch(/thrown later/);
  });

  it('stops a stuck worker, with the end of its stderr', async () => {
    // the worker's start counts too: on a busy machine (the other test
    // files run meanwhile) a short timeout could end before the case runs
    const error = await run('stuck', { timeout: 2000 }).catch(
      (reason: unknown) => reason
    );
    expect((error as Error).message).toMatch(
      /^mm-bench: "stuck" \(sample 1\) made no progress for 2000 ms, so its worker was stopped\.\nWorker stderr:\n.*stuck here/s
    );
  });

  it('rejects when the worker reaches a call with other cases', async () => {
    const error = await run('odd\x1b[2J', {}, ['odd\x1b[2J']).catch(
      (reason: unknown) => reason
    );
    const { message } = error as Error;
    expect(message).toContain('"odd\\x1b[2J" (sample 1) failed');
    expect(message).toContain(
      `other cases (${NAMES.join(', ')}) than the main thread (odd\\x1b[2J)`
    );
    expect(message).not.toContain('\x1b');
  });
});
