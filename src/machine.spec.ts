import { cpus } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { MachineProbe } from './machine.js';

const now = (): bigint => process.hrtime.bigint();

describe('MachineProbe', () => {
  it('probes every core on a timer, counting from the first probe', async () => {
    const probe = new MachineProbe(5);
    const start = now();
    await sleep(40);
    const end = now();
    probe.take();
    probe.stop();
    const { time, busy, idle } = probe.ticks(start, end);
    expect(busy).toHaveLength(cpus().length);
    expect(idle).toHaveLength(cpus().length);
    expect(time[0]).toBeLessThanOrEqual(0);
    expect(time.at(-1)).toBeGreaterThanOrEqual(Number(end - start));
    for (const column of [...busy, ...idle]) {
      expect(column).toHaveLength(time.length);
      expect(column[0]).toBe(0);
      column.forEach((value, index) => {
        expect(value).toBeGreaterThanOrEqual(column[index - 1] ?? 0);
      });
    }
  });

  it('keeps the probes from the last before start to the first after end', async () => {
    const probe = new MachineProbe(1e6);
    await sleep(2);
    probe.take();
    const start = now();
    await sleep(2);
    probe.take();
    const end = now();
    await sleep(2);
    probe.take();
    await sleep(2);
    probe.take();
    probe.stop();
    const { time } = probe.ticks(start, end);
    expect(time).toHaveLength(3);
    expect(time[0]).toBeLessThan(0);
    expect(time[1]).toBeGreaterThan(0);
    expect(time[2]).toBeGreaterThan(Number(end - start));
  });

  it('keeps the nearest probes when they don’t reach that far', () => {
    const probe = new MachineProbe(1e6);
    probe.stop();
    const start = now();
    const { time } = probe.ticks(start, start + 1_000_000n);
    expect(time).toHaveLength(1);
    expect(time[0]).toBeLessThan(0);
  });
});
