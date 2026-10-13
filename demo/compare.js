/**
 * Three ways to build the same string, compared side by side. Samples are
 * interleaved (A B C, C B A, …) and the graphs share their axes.
 *
 * Run: node demo/compare.js
 */
import { bench, compare } from 'mm-bench';

// prepared at the top level: the workers run this file again, so the cases
// see the same data there
const words = Array.from({ length: 50 }, (_, index) => `word${index}`);

await compare(
  bench('join', () => words.join(' ')),
  bench('concat', () => {
    let text = '';
    for (const word of words) text += word + ' ';
    return text;
  }),
  bench('reduce + template', () =>
    words.reduce((text, word) => `${text}${word} `, '')
  )
);
