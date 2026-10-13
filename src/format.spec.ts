import { describe, expect, it } from 'vitest';
import {
  escapeControls,
  formatCount,
  formatRelative,
  formatTime,
  niceCeil,
  timeUnit,
} from './format.js';

describe('formatTime', () => {
  it.each([
    [0, '0ns'],
    [4.5, '4.50ns'],
    [42.25, '42.3ns'],
    [412, '412ns'],
    [999.6, '1.00µs'],
    [1234, '1.23µs'],
    [12_345_678, '12.3ms'],
    [1.2e9, '1.20s'],
    [NaN, '–'],
    [Infinity, '∞'],
  ])('%d ns → %s', (ns, text) => {
    expect(formatTime(ns)).toBe(text);
  });
});

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [12.5, '12.5'],
    [12_345, '12.3k'],
    [999_999, '1.00M'],
    [1.5e6, '1.50M'],
    [4.56e9, '4.56B'],
    [Infinity, '∞'],
  ])('%d → %s', (count, text) => {
    expect(formatCount(count)).toBe(text);
  });
});

describe('formatRelative', () => {
  it('uses percent below twice as slow, a factor from there', () => {
    expect(formatRelative(1.123)).toBe('12.3% slower');
    expect(formatRelative(2.5)).toBe('2.50× slower');
    expect(formatRelative(Infinity)).toBe('∞× slower');
  });
});

describe('escapeControls', () => {
  it('escapes C0, DEL and C1 controls', () => {
    expect(escapeControls('a\x1b[2Jb\n\x7f\x9b')).toBe(
      'a\\x1b[2Jb\\x0a\\x7f\\x9b'
    );
    expect(escapeControls('plain µs ✓')).toBe('plain µs ✓');
  });
});

describe('niceCeil and timeUnit', () => {
  it('rounds up to 1, 2 or 5 times a power of ten', () => {
    expect([0.5, 1, 3, 12, 100, 101].map(niceCeil)).toEqual([
      1, 1, 5, 20, 100, 200,
    ]);
  });

  it('picks the unit of the largest value', () => {
    expect(timeUnit(500).name).toBe('ns');
    expect(timeUnit(5000)).toEqual({ name: 'µs', size: 1e3 });
    expect(timeUnit(5e9).name).toBe('s');
  });
});
