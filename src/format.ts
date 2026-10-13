/** A unit and its size in the base unit. */
export interface Unit {
  readonly name: string;
  readonly size: number;
}

const TIME_UNITS: readonly Unit[] = [
  { name: 'ns', size: 1 },
  { name: 'µs', size: 1e3 },
  { name: 'ms', size: 1e6 },
  { name: 's', size: 1e9 },
];
const COUNT_UNITS: readonly Unit[] = [
  { name: '', size: 1 },
  { name: 'k', size: 1e3 },
  { name: 'M', size: 1e6 },
  { name: 'B', size: 1e9 },
];

/** Values from this share of the next unit up are shown in it (999.6 → 1.00k). */
const ROUND_UP = 0.9995;

/** The largest unit `value` reaches. */
const unitOf = (value: number, units: readonly Unit[]): Unit => {
  let index = 0;
  while (
    index < units.length - 1 &&
    Math.abs(value) >= (units[index + 1]?.size ?? Infinity) * ROUND_UP
  )
    index++;
  return units[index] ?? { name: '', size: 1 };
};

/** Three significant digits, at most two decimals: `1.23`, `12.3`, `123`. */
const significant = (value: number): string => {
  const magnitude = Math.abs(value);
  return value.toFixed(
    magnitude >= 99.95 ? 0
    : magnitude >= 9.995 ? 1
    : 2
  );
};

const special = (value: number): string | undefined =>
  Number.isNaN(value) ? '–'
  : value === Infinity ? '∞'
  : value === -Infinity ? '-∞'
  : value === 0 ? '0'
  : undefined;

const format = (value: number, units: readonly Unit[]): string => {
  const unit = unitOf(value, units);
  return `${significant(value / unit.size)}${unit.name}`;
};

/** Nanoseconds to text: `412ns`, `1.23µs`, `12.3ms`, `1.20s`. */
export const formatTime = (ns: number): string => {
  const text = special(ns);
  return text === '0' ? '0ns' : (text ?? format(ns, TIME_UNITS));
};

/** A count to text: `950`, `12.3k`, `1.23M`, `4.56B`. */
export const formatCount = (count: number): string => {
  const text = special(count);
  if (text !== undefined) return text;
  return Math.abs(count) < 1000 && Number.isInteger(count) ?
      String(count)
    : format(count, COUNT_UNITS);
};

/** Time unit that suits values up to `ns`, to scale graph values. */
export const timeUnit = (ns: number): Unit => unitOf(ns, TIME_UNITS);

/**
 * How much slower a case is, from its mean relative to the fastest:
 * `12.3% slower` below twice as slow, `2.50× slower` from there.
 */
export const formatRelative = (relative: number): string =>
  relative === Infinity ? '∞× slower'
  : relative < 2 ? `${((relative - 1) * 100).toFixed(1)}% slower`
  : `${relative.toFixed(2)}× slower`;

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Escapes control characters, so names can't send terminal sequences. */
export const escapeControls = (text: string): string =>
  text.replace(
    CONTROLS,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
  );

/** The next 1, 2 or 5 times a power of ten at or above `value`. */
export const niceCeil = (value: number): number => {
  if (!(value > 1)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10])
    if (step * power >= value) return step * power;
  return 10 * power;
};
