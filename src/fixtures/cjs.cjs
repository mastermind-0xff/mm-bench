// CommonJS, without top-level await: calls chained with then.
const { bench, compare } = require('@mmutils/bench');

const options = { runs: 100, samples: 2, warmup: { runs: 10 }, output: false };

compare(
  bench('first', () => 1),
  bench('second', () => 2),
  options
)
  .then((report) =>
    bench('third', () => 3)
      .run({ ...options, file: __filename })
      .then((third) => [...report.cases, ...third.cases])
  )
  .then((cases) => {
    console.log(JSON.stringify(cases.map(({ name }) => name)));
  });
