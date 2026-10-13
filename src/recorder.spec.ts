import { describe, expect, it } from 'vitest';
import { countRuns, mergeHistograms, Recorder } from './recorder.js';

describe('Recorder', () => {
  it('counts fast and slow runs in ascending order', () => {
    const recorder = new Recorder();
    for (const ns of [100_000, 7, 70_000, 5, 70_000, 5, 0]) recorder.add(ns);
    expect(recorder.histogram()).toEqual({
      durations: [0, 5, 7, 70_000, 100_000],
      counts: [1, 2, 1, 2, 1],
    });
  });

  it('divides times by the batch size', () => {
    const recorder = new Recorder();
    recorder.add(300);
    recorder.add(100_000);
    expect(recorder.histogram(100)).toEqual({
      durations: [3, 1000],
      counts: [1, 1],
    });
  });

  it('gives an empty histogram without runs', () => {
    expect(new Recorder().histogram()).toEqual({ durations: [], counts: [] });
  });
});

describe('mergeHistograms', () => {
  it('adds the counts of equal durations', () => {
    expect(
      mergeHistograms([
        { durations: [1, 3], counts: [2, 1] },
        { durations: [2, 3], counts: [5, 4] },
      ])
    ).toEqual({ durations: [1, 2, 3], counts: [2, 5, 5] });
  });

  it('returns a single histogram as is', () => {
    const histogram = { durations: [1], counts: [1] };
    expect(mergeHistograms([histogram])).toBe(histogram);
  });
});

describe('countRuns', () => {
  it('sums the counts', () => {
    expect(countRuns({ durations: [1, 2], counts: [3, 4] })).toBe(7);
  });
});
