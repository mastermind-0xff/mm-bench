/**
 * A case with a known distribution: 30% of the calls take about 2µs, 60%
 * about 4µs and 10% about 6µs. The graph should show three bars of 30, 60
 * and 10 percent.
 *
 * Run: node demo/distribution.js
 */
import { bench } from 'mm-bench';

const spin = (ns) => {
  const end = process.hrtime.bigint() + BigInt(ns);
  while (process.hrtime.bigint() < end);
};

const weighted = () => {
  const roll = Math.random();
  spin(
    roll < 0.3 ? 2000
    : roll < 0.9 ? 4000
    : 6000
  );
  return roll;
};

await bench('30% 2µs · 60% 4µs · 10% 6µs', weighted).run();
